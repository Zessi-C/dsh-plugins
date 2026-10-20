// eval-kernel: a persistent Python/R/JS interpreter whose state survives
// across tool calls, confined by the harness's own file-effect policy.
//
// This is a migration of omp's `eval` tool. What omp gets from one long-lived
// interpreter per language, this plugin gets the same way: a child process per
// (agent, language) pair, spoken to over NDJSON. The important property — a
// DataFrame or a Seurat object stays in interpreter memory between calls instead
// of being serialized through a shell — is what makes it different from
// bash-persistent, not merely a longer-lived shell.
//
// R is an addition over omp: its eval backend enum is `py` and `js` only.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// Confinement support, resolved from the host exactly like the tool helper: a
// link: install has no node_modules of its own. A host without these packages
// still loads the plugin -- the missing confinement is reported by the cell that
// needs it, not at install time, so the failure names what is actually wrong.
const sandboxSupport = await (async () => {
  try {
    const landlock = await import(requireFromHarness.resolve('@deepseek-ai/node-addon-system/landlock-run'))
    const { writableRoots } = await import(requireFromHarness.resolve('@deepseek-ai/dsh-sandbox'))
    return { landlock, writableRoots }
  } catch {
    return null
  }
})()

// Probing spawns a short-lived child, so the verdict is computed once per
// process rather than once per interpreter: interpreters come and go, the
// kernel's ability to enforce does not.
let launcherVerdict

/**
 * The file-effect policy this call must run under, or null for no confinement.
 *
 * Returns null when the session's policy grants everything (`danger-full-access`)
 * -- confining there would silently narrow access the harness itself allows.
 * Throws instead of degrading when confinement was asked for but cannot be
 * delivered: an interpreter that looks confined and is not is worse than one
 * that refuses to start.
 */
function sandboxPolicy(ctx, config, agent) {
  if (!config.sandbox) return null
  if (!sandboxSupport) {
    throw new Error(
      'run_cell: the sandbox packages are not resolvable from this harness install; set sandbox: false to run cells unconfined',
    )
  }
  const policyService = ctx.get('sandboxPolicy')
  if (!policyService) {
    throw new Error('run_cell: no sandbox policy provider is mounted; set sandbox: false to run cells unconfined')
  }
  const policy = policyService.resolve(agent === undefined ? {} : { session: agent.session })
  if (!policy || policy.mode === 'danger-full-access') return null

  if (launcherVerdict === undefined) launcherVerdict = sandboxSupport.landlock.probe()
  if (launcherVerdict === 'unusable') {
    throw new Error('run_cell: the landlock launcher cannot enforce confinement on this host')
  }
  return policy
}

/**
 * A stable identity for the confinement an interpreter was started under. Only
 * the policy is part of it: a per-session scratch directory (see
 * {@link createSession}) must not look like a policy change.
 */
function sandboxSignature(policy) {
  return policy === null ? 'unconfined' : `${policy.mode}|${policy.workspaceRoot ?? ''}`
}

/** Launcher argv for one policy, plus any private roots the interpreter needs. */
function buildSandbox(policy, extraWritable = []) {
  const { landlock, writableRoots } = sandboxSupport
  // Mirror the provider's own mapping: reads everywhere, writes only where the
  // policy allows them. `/dev/null` is granted write because a confined process
  // that cannot open it fails in ways that have nothing to do with the policy.
  const readWrite = policy.mode === 'workspace-write' ? writableRoots(policy) : []
  return {
    launcher: landlock.launcherPath(),
    grants: landlock.grantArgs({ readOnly: ['/'], readWrite: ['/dev/null', ...readWrite, ...extraWritable] }),
  }
}

export const Config = z.object({
  pythonBinary: z.string().default('python3').description('Interpreter used for the `py` language.'),
  rBinary: z.string().default('Rscript').description('Interpreter used for the `r` language.'),
  jsBinary: z.string().default('node').description('Interpreter used for the `js` language.'),
  defaultLanguage: z.union([z.const('py'), z.const('r'), z.const('js')]).default('py').description('Language assumed when a call omits `language`.'),
  timeoutMs: z.number().default(300000).description('Per-cell budget in milliseconds; 0 disables the deadline.'),
  maxOutputChars: z.number().default(30000).description('Characters of cell output kept before truncating to head and tail.'),
  sandbox: z
    .boolean()
    .default(true)
    .description(
      'Start each interpreter under the harness file-effect policy (landlock). ' +
        'Disabling this runs cells with the host process\'s unrestricted filesystem access.',
    ),
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

/**
 * Build the interpreter for one (agent, language, policy).
 *
 * R gets a private scratch directory in every mode. It is not a policy
 * relaxation: Rscript creates a session temp directory while booting, so under
 * `read-only` it dies with exit 2 before it can accept a cell. The directory is
 * created here, granted on its own (never `/tmp` as a whole), exported as
 * TMPDIR, and removed with the interpreter.
 */
function createSession(ctx, config, language, policy) {
  const spec = LANGUAGES[language]
  let scratchDir = null
  let extraWritable = []
  let env
  if (policy && language === 'r') {
    scratchDir = mkdtempSync(join(tmpdir(), 'eval-kernel-r-'))
    extraWritable = [scratchDir]
    env = { ...process.env, TMPDIR: scratchDir }
  }
  return new KernelSession({
    language,
    command: spec.command(config),
    args: spec.args(config),
    cwd: ctx.get('workingDirectory')?.defaultDirectory,
    inputMode: spec.inputMode,
    env,
    sandbox: policy ? buildSandbox(policy, extraWritable) : null,
    scratchDir,
  })
}

/**
 * Acquire the interpreter for one call, restarting it when it can no longer be
 * the right one.
 *
 * The file-effect policy is resolved per call, never cached on the interpreter.
 * A conversation's permissions change while it runs -- the user widens or
 * narrows the mode, an escalation is approved -- and an interpreter holding the
 * old ruleset would keep answering under revoked limits, because landlock is
 * irrevocable once exec'd. Only a new process can express a new policy, so a
 * changed signature restarts it and the caller is told its state is gone.
 *
 * A dead interpreter (crashed, aborted, timed out) is likewise replaced rather
 * than thrown at: a wedged process would otherwise poison every later cell.
 */
async function acquireSession(ctx, config, sessions, language, agent, policy, reclaimed) {
  const key = sessionKey(agent?.id, language)
  const signature = sandboxSignature(policy)
  let session = sessions.get(key)
  let restartReason = null

  if (session && session.state === 'dead') {
    sessions.delete(key)
    session = undefined
    restartReason = 'dead'
  }
  if (session && session.policySignature !== signature) {
    await session.kill('policy changed').catch(() => {})
    sessions.delete(key)
    session = undefined
    restartReason = 'policy'
  }
  if (!session) {
    // The idle sweeper drops the entry it kills, so the map alone cannot say
    // that an interpreter used to be here. The tombstone can, and without it
    // the model would silently lose its variables to a timer it never saw.
    if (reclaimed.delete(key)) restartReason = 'idle'
    session = createSession(ctx, config, language, policy)
    session.policySignature = signature
    sessions.set(key, session)
  }
  return { session, restartReason }
}

/**
 * What the model is told when an interpreter had to be replaced. Silently
 * losing a DataFrame is the kind of surprise that turns into a wrong answer, so
 * the loss is reported in the cell's own stderr.
 */
function restartNote(reason) {
  if (reason === 'policy') {
    return 'note: the sandbox policy changed, so the interpreter was restarted; earlier variables are gone.\n'
  }
  if (reason === 'dead') {
    return 'note: the previous interpreter was no longer running, so a fresh one was started; earlier variables are gone.\n'
  }
  if (reason === 'idle') {
    return `note: the interpreter was reclaimed after being idle, so a fresh one was started; earlier variables are gone.\n`
  }
  return ''
}

export function apply(ctx, config) {
  const sessions = new Map()
  // Keys whose interpreter was killed while nobody was looking, so the next
  // call can say so instead of handing back a silently empty namespace.
  const reclaimed = new Set()

  // Build the tool definition BEFORE registering any effect. Constructing it is
  // pure, so a malformed definition throws here with nothing half-registered;
  // registering a side effect first and failing afterwards is what left an
  // unowned timer behind on the first install attempt.
  const tool = createEvalTool(ctx, config, sessions, reclaimed)

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
            reclaimed.add(key)
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

function createEvalTool(ctx, config, sessions, reclaimed) {
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
      'The interpreter runs under the session file-effect policy, so a cell cannot write outside the ' +
      'workspace (use `bash` when you need a shell). ' +
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

      const key = sessionKey(exec.agent?.id, language)

      // Resolved before anything is killed or reused: a policy that cannot be
      // read is a failed call, not a licence to run the old process.
      const policy = sandboxPolicy(ctx, config, exec.agent)

      if (args.reset) {
        const existing = sessions.get(key)
        if (existing) await existing.kill('reset')
        sessions.delete(key)
      }

      const { session, restartReason } = await acquireSession(ctx, config, sessions, language, exec.agent, policy, reclaimed)
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
        stderr: truncate(restartNote(restartReason) + outcome.stderr, config.maxOutputChars),
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
