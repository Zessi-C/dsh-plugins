// eval-kernel: a persistent Python/R/JS interpreter whose state survives
// across tool calls, with cells able to call back into the harness's own tools.
//
// This is a migration of omp's `eval` tool. What omp gets from one long-lived
// interpreter per language, this plugin gets the same way: a child process per
// (agent, language) pair, spoken to over NDJSON. The important property — a
// DataFrame or a Seurat object stays in interpreter memory between calls instead
// of being serialized through a shell — is what makes it different from
// bash-persistent, not merely a longer-lived shell.
//
// R is an addition over omp: its eval backend enum is `py` and `js` only.

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { KernelSession } from './kernel-session.js'

export const name = 'eval-kernel'
export const inject = ['tools']

// A linked profile package has no node_modules of its own, so Harness packages
// are resolved from the running dsh CLI (its lib/bin.js) instead of imported
// statically. See MEMORY: static `import '@deepseek-ai/...'` fails for link: installs.
// The harness exposes its own CLI entry as argv[1] in every profile launch, so
// `createRequire` there resolves the packages it was installed with. The env
// override exists for tests that load this module outside a harness process.
const anchor = process.env.DSH_EVAL_KERNEL_ANCHOR ?? process.argv[1] ?? import.meta.url
const requireFromHarness = createRequire(anchor)
const z = requireFromHarness('@deepseek-ai/schemastery')
// The tool helper compiles the author-facing schema DSL into the standard JSON
// Schema object an OpenAI-compatible endpoint expects. Hand-building the tool
// object instead leaves `parameters` as a bare property map, which the endpoint
// rejects with `invalid function call parameters`.
const { defineTool } = await import(
  requireFromHarness.resolve('@deepseek-ai/dsh-tools').replace(/\/lib\/index\.js$/, '/lib/index.js'),
)

export const Config = z.object({
  pythonBinary: z.string().default('python3').description('Interpreter used for the `py` language.'),
  rBinary: z.string().default('Rscript').description('Interpreter used for the `r` language.'),
  jsBinary: z.string().default('node').description('Interpreter used for the `js` language.'),
  defaultLanguage: z.union([z.const('py'), z.const('r'), z.const('js')]).default('py').description('Language assumed when a call omits `language`.'),
  timeoutMs: z.number().default(300000).description('Per-cell budget in milliseconds; 0 disables the deadline.'),
  maxOutputChars: z.number().default(30000).description('Characters of cell output kept before truncating to head and tail.'),
  bridgeTools: z
    .array(z.string())
    .default(['read', 'write', 'edit', 'bash', 'grep', 'glob'])
    .description('Harness tools exposed to cells as plain functions of the same name.'),
  idleTimeoutMs: z.number().default(1800000).description('Reclaim an idle interpreter after this long; 0 keeps it.'),
})

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Language descriptors: how to start each interpreter and where its wrapper lives. */
const LANGUAGES = {
  py: {
    label: 'Python',
    command: (config) => config.pythonBinary,
    args: () => ['-u', join(LIB_DIR, 'py-runner.py')],
    inputMode: 'stdin',
  },
  r: {
    label: 'R',
    command: (config) => config.rBinary,
    // {fifo} is replaced with the per-session named pipe. Rscript cannot reopen
    // an anonymous pipe on Linux, so the child reads a real path instead.
    args: () => ['--vanilla', join(LIB_DIR, 'r-runner.R'), '{fifo}'],
    inputMode: 'fifo',
  },
  js: {
    label: 'JavaScript',
    command: (config) => config.jsBinary,
    args: () => [join(LIB_DIR, 'js-runner.mjs')],
    inputMode: 'stdin',
  },
}

/**
 * One interpreter per (agent, language), keyed by agent id so two agents never
 * share mutable interpreter state.
 *
 * The map is created per `apply()` call, not at module scope. A module-level map
 * outlives a hot reload: the new instance would inherit the old instance's live
 * children, and the old instance's disposer would then kill interpreters the new
 * one is already using.
 */
function sessionKey(agentId, language) {
  return `${agentId ?? 'global'}::${language}`
}

function getSession(ctx, config, sessions, language, agentId) {
  const key = sessionKey(agentId, language)
  const existing = sessions.get(key)
  // Reuse whatever is in the map, alive or still starting. A concurrent caller
  // must join the same interpreter: replacing it mid-flight kills the process
  // the first caller is already talking to, which surfaces as "interpreter is
  // not running" for every call but the last.
  if (existing) return existing
  const spec = LANGUAGES[language]
  const session = new KernelSession({
    language,
    command: spec.command(config),
    args: spec.args(config),
    cwd: ctx.get('workingDirectory')?.defaultDirectory,
    env: { ...process.env, DSH_EVAL_BRIDGE_TOOLS: config.bridgeTools.join(',') },
    inputMode: spec.inputMode,
  })
  // The child calls harness tools through this handler. It answers with the
  // tool's text content, which is what a cell can meaningfully consume.
  session.toolHandler = async (frame) => {
    if (!frame?.name) throw new Error('bridge call is missing a tool name')
    const tools = ctx.get('tools')
    if (!tools) throw new Error('tool registry is not available')
    const controller = new AbortController()
    const result = await tools.execute({
      name: frame.name,
      arguments: frame.args ?? {},
      callId: `eval-bridge-${Date.now()}`,
      signal: controller.signal,
      agent: agentId ? { id: agentId } : undefined,
    })
    const text = (result.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (result.isError) throw new Error(text || `${frame.name} failed`)
    return text
  }
  sessions.set(key, session)
  return session
}

export function apply(ctx, config) {
  const sessions = new Map()

  // Build the tool definition BEFORE registering any effect. Constructing it is
  // pure, so a malformed definition throws here with nothing half-registered;
  // registering a side effect first and failing afterwards is what left an
  // unowned timer behind on the first install attempt.
  const tool = createEvalTool(ctx, config, sessions)

  // The tool is the plugin's whole purpose: register it first so a failure
  // below cannot leave the profile with effects but no working capability.

  ctx.effect(() => ctx.tools.register(tool))

  ctx.effect(() => () => {
    // Unloading the plugin or disposing the agent stops its interpreters; an
    // orphaned interpreter would hold memory no one can address again.
    // The disposer returns the teardown promise so the context can wait for it:
    // clearing the map first would drop children that are still starting and
    // leave their processes running with nothing left to address them.
    const children = [...sessions.values()]
    sessions.clear()
    return Promise.all(children.map((session) => session.kill('plugin unloaded').catch(() => {})))
  })

  // Reclaim interpreters nobody is using. A plain timer owned by the plugin
  // effect, not ctx.setInterval, so the plugin does not depend on the `timer`
  // service just to expire idle children.
  if (config.idleTimeoutMs > 0) {
    ctx.effect(() => {
      const handle = setInterval(() => {
        const now = Date.now()
        for (const [key, session] of sessions) {
          if (session.lastUsedAt && now - session.lastUsedAt > config.idleTimeoutMs) {
            session.kill('idle').catch(() => {})
            sessions.delete(key)
          }
        }
      }, Math.min(config.idleTimeoutMs, 60_000))
      handle.unref?.()
      return () => clearInterval(handle)
    })
  }
}

function createEvalTool(ctx, config, sessions) {
  const descriptions = Object.entries(LANGUAGES)
    .map(([token, spec]) => `\`${token}\` (${spec.label})`)
    .join(', ')

  return defineTool({
    name: 'run_cell',
    description:
      `Run one code cell in a persistent ${descriptions} interpreter and return its printed output. ` +
      'Interpreter state — variables, imports, loaded data — survives between calls, so a large object ' +
      'never has to be written to disk and read back. Use this instead of `bash` for exploratory ' +
      'computation; use `bash` for shell work. ' +
      `Cells may call these harness tools as plain functions: ${config.bridgeTools.join(', ')}. ` +
      'A failing cell returns its traceback and leaves the interpreter alive. ' +
      'Pass `reset: true` to discard the interpreter and start clean.',
    // The parameter root is an implicit object; each property is a
    // ValueSchemaSpec and requiredness is a per-property annotation.
    parameters: {
      code: { type: 'string', required: true, description: 'The code to execute as one cell.' },
      language: {
        type: 'string',
        enum: Object.keys(LANGUAGES),
        description: `Interpreter language; defaults to \`${config.defaultLanguage}\`.`,
      },
      title: { type: 'string', description: 'Short label for this cell, shown in the transcript.' },
      reset: { type: 'boolean', description: 'Discard the existing interpreter before running this cell.' },
      timeoutMs: { type: 'number', description: 'Per-cell budget; overrides the configured default.' },
    },

    async execute(args, exec) {
      const language = args.language ?? config.defaultLanguage
      const spec = LANGUAGES[language]
      if (!spec) throw new Error(`unsupported language: ${language}`)

      const agentId = exec.agent?.id
      const key = sessionKey(agentId, language)

      if (args.reset) {
        const existing = sessions.get(key)
        if (existing) await existing.kill('reset')
        sessions.delete(key)
      }

      const session = getSession(ctx, config, sessions, language, agentId)
      session.lastUsedAt = Date.now()
      const timeoutMs = resolveTimeout(args.timeoutMs, config.timeoutMs)

      const started = Date.now()
      let outcome
      try {
        outcome = await session.execute(args.code, { signal: exec.signal, timeoutMs })
      } finally {
        // Refresh on failure too: a cell that just errored is still a live
        // interpreter the next call will reuse, so idleness must restart here
        // rather than from the last successful run.
        session.lastUsedAt = Date.now()
      }

      return {
        language,
        // The output schema declares `title` as a string, so an absent label is
        // the empty string, never null: null would fail our own schema check and
        // turn every title-less call into TOOL_OUTPUT_INVALID.
        title: args.title ?? '',
        stdout: truncate(outcome.stdout, config.maxOutputChars),
        stderr: truncate(outcome.stderr, config.maxOutputChars),
        executionCount: outcome.executionCount,
        durationMs: Date.now() - started,
      }
    },

    output: {
      schema: {
        type: 'object',
        // Object schema openness is mandatory in this DSL: a nested or output
        // object never acquires an implicit `additionalProperties` default, so
        // omitting it is rejected rather than guessed.
        additionalProperties: false,
        properties: {
          language: { type: 'string' },
          title: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          executionCount: { type: 'number' },
          durationMs: { type: 'number' },
        },
      },
      // The cell's own output is what the model needs to see. Returning an
      // empty array here would make every successful call look silent.
      render: (_args, value) => {
        const parts = []
        if (value.stdout) parts.push(value.stdout)
        if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
        if (parts.length === 0) parts.push(`(${value.language} cell returned no output)`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },

    // An interpreter has one state; two cells must never interleave.
    isConcurrencySafe: () => false,
  })
}

/** A per-call budget override, rejected unless it is a positive finite number. */
function resolveTimeout(requested, fallback) {
  if (requested === undefined) return fallback
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) {
    throw new Error(`invalid timeoutMs: expected a non-negative finite number, got ${JSON.stringify(requested)}`)
  }
  return requested
}

function truncate(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text ?? ''
  const half = Math.floor(limit / 2)
  return `${text.slice(0, half)}\n... [truncated ${text.length - limit} characters] ...\n${text.slice(-half)}`
}
