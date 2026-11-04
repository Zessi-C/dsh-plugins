/**
 * Vibe orchestrator — Host half.
 *
 * One Agent preset, `vibe`, is a Vibe session. Its preset mounts the full working
 * toolset, because every delegated worker inherits it. This Host row then shapes
 * each Agent by its role, which is what produces the mode:
 *
 * | Agent                           | persona      | tools                                                    |
 * |---------------------------------|--------------|----------------------------------------------------------|
 * | root session (the orchestrator)  | orchestrator | allowlist: read/glob/grep/todo_write, the `vibe_*` tools, agent messaging |
 * | child delegated by `vibe_fast`   | fast worker  | full working toolset                                     |
 * | child delegated by `vibe_good`   | good worker  | full working toolset                                     |
 * | child delegated by `vibe_expert` | expert       | full read, may write new files, cannot edit or run shell |
 *
 * No other preset exists, so the mode roster shows exactly one Vibe mode and the
 * three tiers stay an implementation detail. Children are ordinary subagents that
 * inherit the parent's preset, so they differ only by the model route the tier
 * tool selects and by the boundary applied here.
 *
 * Two events drive the shaping, because a Session can join the preset either way:
 * `agent/created` covers a Session created with the preset already in its header,
 * and `agent-preset/selected` covers a blank Session switched to the preset
 * afterwards. Selecting another preset unwinds everything this row installed.
 *
 * The tier routes are volatile fields of this Loader entry, so the Settings page
 * edits them and the next delegation picks the change up without a restart.
 *
 * @module dsh-vibe-orchestrator
 */
import { importHostPackage } from './dsh.js'
import { PERSONAS, TIERS, tierDescription } from './copy.js'

const z = (await importHostPackage('@deepseek-ai/schemastery')).default
const { scopeOf } = await importHostPackage('@deepseek-ai/dsh-scope')

/** The one preset that identifies a Vibe session. */
export const PRESET_ID = 'vibe'

/** Loader entry id that owns the tier routes. */
export const SETTINGS_ENTRY_ID = 'vibe-orchestrator'

/**
 * Tools the orchestrator may run: reading the workspace, planning, and the
 * delegation surface itself. Everything else is denied, so a tool this file has
 * never heard of is out of reach too.
 */
const ORCHESTRATOR_ALLOW = new Set([
  'read', 'glob', 'grep', 'todo_write',
  'vibe_fast', 'vibe_good', 'vibe_expert', 'vibe_runs',
  'send_message', 'interrupt_agent', 'list_agents',
  'ask_user_question',
])

/** Tools the expert may not run. */
const EXPERT_DENY = ['edit', 'bash', 'pwsh']

/** Persona role per tier. */
const ROLE_OF_TIER = { fast: 'fast', good: 'good', expert: 'expert' }

/**
 * The structured receipt every delegated worker is asked to return.
 *
 * `state` names its scalar type explicitly: the enforced JSON Schema subset
 * rejects an `enum` that is not declared beside a scalar `type`.
 */
const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: ['ready', 'blocked', 'failed'] },
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['state', 'summary'],
}

/** What `vibe_runs` returns: one normalized row per recorded dispatch. */
const RUNS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'runs' },
    count: { type: 'integer' },
    runs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          tier: { type: 'string' },
          model: { type: 'string' },
          label: { type: 'string' },
          task: { type: 'string' },
          state: { type: 'string' },
          stopReason: { type: 'string' },
          structuredState: { type: 'string' },
          files: { type: 'integer' },
          diagnostic: { type: 'string' },
          startedAt: { type: 'string' },
          endedAt: { type: 'string' },
        },
        required: ['id', 'tier', 'model', 'label', 'state'],
      },
    },
  },
  required: ['kind', 'count', 'runs'],
}

/** How long one route verdict is reused before the runtime is asked again. */
const PREFLIGHT_TTL_MS = 10 * 60 * 1000

/** Route key → its cached verdict; `error` is present when the route is unusable. */
const routeChecks = new Map()

/** Orchestrator Session id → its dispatch ledger, oldest entry first. */
const RUNS = new Map()

/** Terminal stop reason → the ledger state it is recorded as. */
const RUN_STATE = {
  completed: 'completed',
  error: 'failed',
  aborted: 'aborted',
  'max-tokens': 'max-tokens',
  refusal: 'refusal',
}

/**
 * Live tier routes. Every field is `volatile()`, so the Settings page edits them
 * and the next delegation reads the new value.
 */
export const Config = z.object({
  vibeFastProvider: z.string().default('agent2cli').volatile(),
  vibeFastModel: z.string().default('deepseek-v4.1-flash').volatile(),
  vibeFastEffort: z.string().volatile(),

  vibeGoodProvider: z.string().default('cpa').volatile(),
  vibeGoodModel: z.string().default('gemini-3.8-flash-high').volatile(),
  vibeGoodEffort: z.string().volatile(),

  vibeExpertProvider: z.string().default('cpa').volatile(),
  vibeExpertModel: z.string().default('gpt-6.1-sol').volatile(),
  vibeExpertEffort: z.string().volatile(),

})

/**
 * Read one volatile field, which the Loader exposes as a live accessor.
 * @param {unknown} value - Declared config field.
 * @returns {string|undefined} Its current text, or undefined when unset.
 */
function text(value) {
  const raw = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Build the three tier routes from the live config.
 * @param {object} config - Plugin config.
 * @returns {Record<string, {provider: string, model: string, reasoningEffort?: string}>}
 */
function routes(config) {
  const route = (suffix, fallbackProvider, fallbackModel) => ({
    provider: text(config[`vibe${suffix}Provider`]) ?? fallbackProvider,
    model: text(config[`vibe${suffix}Model`]) ?? fallbackModel,
    reasoningEffort: text(config[`vibe${suffix}Effort`]),
  })
  return {
    fast: route('Fast', 'agent2cli', 'deepseek-v4.1-flash'),
    good: route('Good', 'cpa', 'gemini-3.8-flash-high'),
    expert: route('Expert', 'cpa', 'gpt-6.1-sol'),
  }
}

/** The message of an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Shorten one free-text ledger field.
 * @param {unknown} value
 * @param {number} limit - Maximum retained characters.
 * @returns {string|undefined} The trimmed text, or undefined when it is empty.
 */
function clip(value, limit) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`
}

/**
 * Confirm the LLM runtime can serve one route before a child is created.
 *
 * `resolveCallConfig` is the runtime's own admission check: it resolves the
 * provider adapter, the exact model, and the reasoning effort, so an unusable
 * route fails here with the runtime's diagnostic instead of becoming a child
 * that can never produce a turn. The verdict is cached briefly because the
 * Settings page can change a route at any moment.
 *
 * A deployment that does not mount the `llm` service is not preflighted at all:
 * the dispatch then behaves exactly as it did before this check existed.
 * @param {object} ctx - Context that resolves the `llm` service.
 * @param {{provider: string, model: string, reasoningEffort?: string}} route
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>} Resolves when the route is usable.
 */
async function preflightRoute(ctx, route, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') return
  const key = `${route.provider}/${route.model}/${route.reasoningEffort ?? '-'}`
  const cached = routeChecks.get(key)
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    if (cached.error === undefined) return
    throw cached.error
  }
  try {
    await llm.resolveCallConfig(
      {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      },
      signal,
    )
    routeChecks.set(key, { expiresAt: Date.now() + PREFLIGHT_TTL_MS })
  } catch (error) {
    routeChecks.set(key, { expiresAt: Date.now() + PREFLIGHT_TTL_MS, error })
    throw error
  }
}

/**
 * Append one dispatch to its orchestrator's ledger.
 * @param {string} parentId - Orchestrator Session id.
 * @param {object} entry - Ledger fields to record.
 * @returns {object} The live entry, which its result promise fills in later.
 */
function openRun(parentId, entry) {
  const bucket = RUNS.get(parentId) ?? []
  const run = { id: '', ...entry }
  bucket.push(run)
  RUNS.set(parentId, bucket)
  return run
}

/**
 * Record how one dispatch ended.
 *
 * The tool has already returned by the time this runs, so nothing here may
 * throw: a bookkeeping failure must not become an unhandled rejection, and it
 * must not replace the run's real outcome.
 * @param {object} run - The live ledger entry.
 * @param {{stopReason?: string, diagnostic?: string, structured?: unknown}} result
 */
function settleRun(run, result) {
  try {
    if (run.state !== 'running') return
    const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'error'
    run.stopReason = stopReason
    run.state = RUN_STATE[stopReason] ?? 'failed'
    run.endedAt = new Date().toISOString()
    const diagnostic = clip(result?.diagnostic, 200)
    if (diagnostic !== undefined) run.diagnostic = diagnostic
    if (result?.structured !== undefined) run.structured = result.structured
  } catch {
    // The outcome already recorded stands.
  }
}

/**
 * Project one ledger entry onto the `vibe_runs` row shape.
 * @param {object} run
 * @returns {object}
 */
function runRow(run) {
  const row = { id: run.id, tier: run.tier, model: run.model, label: run.label, state: run.state }
  if (run.task !== undefined) row.task = run.task
  if (run.stopReason !== undefined) row.stopReason = run.stopReason
  if (typeof run.structured?.state === 'string') row.structuredState = run.structured.state
  if (Array.isArray(run.structured?.files)) row.files = run.structured.files.length
  if (run.diagnostic !== undefined) row.diagnostic = run.diagnostic
  if (run.startedAt !== undefined) row.startedAt = run.startedAt
  if (run.endedAt !== undefined) row.endedAt = run.endedAt
  return row
}

/**
 * Render the ledger as one compact line per dispatch.
 * @param {object} value - A `vibe_runs` result.
 * @returns {string}
 */
function renderRuns(value) {
  const runs = Array.isArray(value?.runs) ? value.runs : []
  if (runs.length === 0) return 'No dispatches yet in this session.'
  return runs
    .map((run, index) => {
      const line = [`#${index + 1}`, run.tier, run.model, run.label, `— ${run.state}`]
      if (run.stopReason !== undefined) line.push(`(${run.stopReason})`)
      if (run.structuredState !== undefined) line.push(run.structuredState)
      if (run.files !== undefined) line.push(`${run.files} files`)
      if (run.diagnostic !== undefined) line.push(`· ${run.diagnostic}`)
      return line.join(' ')
    })
    .join('\n')
}

/**
 * Build the ledger-reading tool. It is registered for the orchestrator only:
 * a worker has no ledger of its own, and its dispatches belong to the
 * orchestrator that started it.
 * @returns {object} The tool definition.
 */
function runsTool() {
  return {
    name: 'vibe_runs',
    description:
      'List the dispatches this orchestration session made, oldest first, with each one\'s state, stop reason, and the structured receipt its worker returned. Use it before reporting, to see which delegated work actually finished.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: RUNS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRuns(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const parent = exec.agent
      const bucket = parent === undefined ? [] : (RUNS.get(parent.id) ?? [])
      return { kind: 'runs', count: bucket.length, runs: bucket.map(runRow) }
    },
  }
}

/**
 * Build one tier delegation tool.
 * @param {'fast'|'good'|'expert'} tier
 * @param {() => Record<string, object>} current - Live route reader.
 * @param {(childId: string, tier: string) => void} remember - Records a child's tier.
 */
function tierTool(tier, current, remember) {
  return {
    name: `vibe_${tier}`,
    description: tierDescription(tier),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The complete instruction for the subagent. It starts with this text and cannot see this conversation, so include every path, observed failure, and decision it needs.',
        },
        label: {
          type: 'string',
          description: 'A short display label of at most five words, such as "read config loader".',
        },
        force: {
          type: 'boolean',
          description: '派发前仍预检失败时强制执行',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
          tier: { type: 'string' },
          model: { type: 'string' },
        },
        required: ['kind', 'subagentId', 'tier', 'model'],
      },
      render: (_args, value) => [
        { type: 'text', text: `started ${value?.tier ?? tier} subagent ${value?.subagentId ?? '?'} (${value?.model ?? '?'})` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('vibe delegation requires a calling agent')
      }
      const task = typeof args?.task === 'string' ? args.task : ''
      if (task.trim().length === 0) {
        throw new Error('vibe delegation requires a non-empty task')
      }
      const subagents = parent.ctx.get('subagents')
      if (subagents === undefined) {
        throw new Error('vibe delegation requires the subagent service')
      }
      const route = current()[tier]
      const model = `${route.provider}/${route.model}`
      const shortLabel = typeof args?.label === 'string' && args.label.trim().length > 0 ? args.label.trim() : 'task'
      const startedAt = new Date().toISOString()
      if (args?.force !== true) {
        try {
          await preflightRoute(parent.ctx, route, exec.signal)
        } catch (error) {
          // A cancelled tool call is not a bad route; let the real reason out.
          if (exec.signal?.aborted === true) throw error
          const reason = messageOf(error)
          openRun(parent.id, {
            tier,
            model,
            label: shortLabel,
            task: clip(task, 80),
            state: 'preflight-failed',
            diagnostic: clip(reason, 200),
            startedAt,
          })
          throw new Error(
            `route ${model} is not usable: ${reason}。到 Plugins → Vibe 改路由，或传 force:true 跳过预检。`,
          )
        }
      }
      const agentOptions = {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      }
      let activation
      try {
        activation = await subagents.startActivation({
          provider: 'spawn',
          // The tier prefix is how the child's role is recognised again while it is
          // created, and it keeps the roster readable.
          label: `${tier} · ${shortLabel}`.slice(0, 80),
          request: {
            parent,
            agentOptions,
            prompt: [{ type: 'text', text: task }],
            outputSchema: RECEIPT_SCHEMA,
          },
          signal: exec.signal,
          delivery: 'parent',
        })
      } catch (error) {
        openRun(parent.id, {
          tier,
          model,
          label: shortLabel,
          task: clip(task, 80),
          state: RUN_STATE.error,
          diagnostic: clip(messageOf(error), 200),
          startedAt,
        })
        throw error
      }
      const run = openRun(parent.id, {
        id: activation.childId,
        tier,
        model,
        label: shortLabel,
        task: clip(task, 80),
        state: 'running',
        startedAt,
      })
      // The receipt arrives long after this tool returned, so it is booked in the
      // background rather than awaited.
      void activation.result.then(
        (result) => settleRun(run, result),
        (error) => settleRun(run, { stopReason: 'error', diagnostic: messageOf(error) }),
      )
      remember(activation.childId, tier)
      return {
        kind: 'activation',
        subagentId: activation.childId,
        tier,
        model,
      }
    },
  }
}

/**
 * Read the tier a worker was started for from its catalog label.
 * @param {unknown} label
 * @returns {'fast'|'good'|'expert'|undefined}
 */
function tierFromLabel(label) {
  if (typeof label !== 'string') return undefined
  const head = label.split(' · ', 1)[0]
  return TIERS.includes(head) ? head : undefined
}

/** Whether a Session is a delegated worker rather than the orchestrator root. */
function isWorker(header) {
  return header.parentSession !== undefined || header.origin === 'subagent'
}

/** Run one disposer whatever shape it has. */
function runDisposer(disposer) {
  try {
    if (typeof disposer === 'function') disposer()
    else if (disposer !== null && typeof disposer?.dispose === 'function') disposer.dispose()
  } catch {
    // A failed unwind must not stop the remaining ones.
  }
}

const name = 'vibe-orchestrator'
const inject = ['tools', 'subagents', 'systemPrompt', 'agents']

/**
 * Shape every Agent that runs the Vibe preset.
 * @param {object} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  /** Child session id → the tier that started it, for the expert guard. */
  const childTier = new Map()
  /** Session id → the disposers of everything installed for its Vibe role. */
  const shaped = new Map()

  const remember = (childId, tier) => {
    childTier.set(childId, tier)
  }

  /** Release everything installed for one Session's Vibe role. */
  const unshape = (sessionId) => {
    const disposers = shaped.get(sessionId)
    if (disposers === undefined) return
    shaped.delete(sessionId)
    for (let index = disposers.length - 1; index >= 0; index -= 1) runDisposer(disposers[index])
  }

  /** Install the orchestrator role, replacing anything installed before. */
  const shapeOrchestrator = (agent) => {
    unshape(agent.id)
    shaped.set(agent.id, installOrchestrator(agent, config, remember))
  }

  /** Install a worker role, replacing anything installed before. */
  const shapeWorker = (agent, tier) => {
    unshape(agent.id)
    shaped.set(agent.id, installWorker(agent, tier, childTier))
  }

  const shape = async (agent, presetId) => {
    if (presetId !== PRESET_ID) {
      unshape(agent.id)
      return
    }
    const header = agent.session?.header
    if (header === undefined) return
    if (!isWorker(header)) {
      shapeOrchestrator(agent)
      return
    }
    shapeWorker(agent, await resolveChildTier(ctx, agent, header, childTier))
  }

  /** Session id → the preset it selected before its Agent was registered. */
  const pendingPreset = new Map()

  /**
   * Resolve the preset a Session runs.
   *
   * The `agentPreset` projection is authoritative: a Session created as
   * `standard` and later switched to `vibe` keeps `standard` in its header, and
   * only the projection follows the selection. The header is the fallback for a
   * Session whose projection service is not mounted, and the pending selection
   * covers an event that arrived before this Agent was registered.
   * @param {object} agent
   * @returns {string|undefined}
   */
  const presetOf = (agent) => {
    try {
      const projections = ctx.get('sessionProjections')
      const state = typeof projections?.stateOf === 'function'
        ? projections.stateOf(agent.session, 'agentPreset')
        : undefined
      if (typeof state === 'string' && state.length > 0) return state
    } catch {
      // A missing projection service leaves the header as the answer.
    }
    const header = agent.session?.header
    if (typeof header?.agentPreset === 'string') return header.agentPreset
    return pendingPreset.get(agent.id)
  }

  /** Session id → the preset its shaping was last applied for. */
  const shapedAs = new Map()

  /**
   * Shape one Agent from whatever preset fact is readable now.
   *
   * A restored Session reconstructs its projection lazily, so a first attempt can
   * read a truth that is about to change. `shapedAs` keeps a repeated attempt from
   * undoing a shaping that already matches.
   * @param {object} agent
   * @returns {Promise<boolean>} Whether the Agent was shaped.
   */
  const shapeFromFacts = async (agent) => {
    const preset = presetOf(agent)
    if (preset === undefined) return false
    if (shapedAs.get(agent.id) === preset) return true
    pendingPreset.delete(agent.id)
    await shape(agent, preset)
    shapedAs.set(agent.id, preset)
    return true
  }

  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session?.header === undefined) return
    // Always schedule the re-reads. The first answer can come from the header
    // while a restored Session's projection is still reconstructing, and that
    // provisional answer must not end the attempt: a later read may correct it.
    await shapeFromFacts(agent)
    for (const delay of [0, 250, 1000, 3000, 8000]) {
      setTimeout(() => {
        void shapeFromFacts(agent)
      }, delay)
    }
  })

  // A blank Session switched to Vibe after it was created joins the preset without
  // a second `agent/created`, so the recorded selection drives the same shaping.
  // A restored Session replays this selection before its Agent is registered, so
  // keep it and apply it once that Agent exists.
  ctx.on('agent-preset/selected', async (sessionId, presetId) => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      pendingPreset.set(sessionId, presetId)
      setTimeout(() => {
        const later = ctx.agents.get(sessionId)
        if (later === undefined) return
        if (pendingPreset.get(sessionId) !== presetId) return
        pendingPreset.delete(sessionId)
        void shape(later, presetId)
      }, 0)
      return
    }
    pendingPreset.delete(sessionId)
    await shape(agent, presetId)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    shaped.delete(agent.id)
    shapedAs.delete(agent.id)
    childTier.delete(agent.id)
    pendingPreset.delete(agent.id)
    // The ledger belongs to the Session that made the dispatches, so it goes
    // when that Session goes.
    RUNS.delete(agent.id)
  })
}

/**
 * Shape the root session: read-only, with the three tier tools.
 * @param {object} agent
 * @param {object} config
 * @param {(childId: string, tier: string) => void} remember
 * @returns {unknown[]} Disposers for everything installed.
 */
function installOrchestrator(agent, config, remember) {
  const disposers = [installPersona(agent, 'orchestrator')]
  const current = () => routes(config)
  for (const tier of TIERS) {
    const definition = tierTool(tier, current, remember)
    disposers.push(
      agent.ctx.effect(
        () => agent.ctx.tools.register(definition),
        `vibe-orchestrator: ${definition.name}`,
      ),
    )
  }
  const ledger = runsTool()
  disposers.push(
    agent.ctx.effect(
      () => agent.ctx.tools.register(ledger),
      `vibe-orchestrator: ${ledger.name}`,
    ),
  )
  disposers.push(...allowOnly(agent, ORCHESTRATOR_ALLOW))
  // A guard is the backstop: it names no registry, so the boundary still holds
  // when a restriction could not be applied.
  disposers.push(
    agent.ctx.effect(
      () =>
        agent.ctx.tools.guard((exec) => {
          if (ORCHESTRATOR_ALLOW.has(exec.name)) return undefined
          return `The Vibe orchestrator does not run "${exec.name}". Delegate this work to vibe_fast or vibe_good and report the result.`
        }),
      'vibe-orchestrator: orchestrator guard',
    ),
  )
  return disposers
}

/**
 * Shape one delegated worker: its tier persona, and the expert's boundary.
 * @param {object} agent
 * @param {'fast'|'good'|'expert'|undefined} tier
 * @param {Map<string, string>} childTier
 * @returns {unknown[]} Disposers for everything installed.
 */
function installWorker(agent, tier, childTier) {
  const disposers = []
  if (tier !== undefined) disposers.push(installPersona(agent, ROLE_OF_TIER[tier]))

  // The tier is also resolved at call time, so the expert boundary holds even when
  // the child's catalog row was not readable while it was created.
  disposers.push(
    agent.ctx.effect(
      () =>
        agent.ctx.tools.guard((exec) => {
          const id = exec.agent?.session?.header?.id
          if (id === undefined || childTier.get(id) !== 'expert') return undefined
          if (!EXPERT_DENY.includes(exec.name)) return undefined
          return `The expert tier advises and writes plans; it does not run "${exec.name}". Return the recommendation so the orchestrator can implement it through a fast or good worker.`
        }),
      'vibe-orchestrator: expert guard',
    ),
  )

  if (tier === 'expert') disposers.push(...denyTools(agent, EXPERT_DENY))
  return disposers
}

/**
 * Resolve which tier started a child, preferring its durable catalog row.
 * @param {object} ctx
 * @param {object} agent
 * @param {object} header
 * @param {Map<string, string>} childTier
 * @returns {Promise<'fast'|'good'|'expert'|undefined>}
 */
async function resolveChildTier(ctx, agent, header, childTier) {
  const remembered = childTier.get(agent.id)
  if (remembered !== undefined) return remembered
  try {
    const children = await ctx.subagents.listChildren(header.parentSession)
    const tier = tierFromLabel(children.find((entry) => entry.id === agent.id)?.label)
    if (tier !== undefined) childTier.set(agent.id, tier)
    return tier
  } catch {
    return undefined
  }
}

/**
 * Give one Agent its role persona by shadowing the deployment persona.
 * @param {object} agent
 * @param {string} role
 * @returns {unknown} The installation's disposer.
 */
function installPersona(agent, role) {
  const persona = PERSONAS[role]
  if (persona === undefined) return undefined
  return agent.ctx.effect(
    () =>
      agent.ctx.systemPrompt.section({
        name: 'deployment:persona-prefix',
        order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: persona,
      }),
    `vibe-orchestrator: ${role} persona`,
  )
}

/**
 * Reduce one Agent's visible set to the named tools.
 *
 * Names are filtered against what the Agent can see and can restrict, because
 * `restrict()` rejects an unknown global name outright.
 * @param {object} agent
 * @param {Set<string>} allowed
 * @returns {unknown[]} Disposers for the applied restrictions.
 */
function allowOnly(agent, allowed) {
  try {
    const visible = new Set(agent.ctx.tools.schemas(scopeOf(agent.ctx)).map((tool) => tool.name))
    const denied = [...visible].filter((name) => !allowed.has(name))
    if (denied.length === 0) return []
    return [
      agent.ctx.effect(
        () => agent.ctx.tools.restrict({ deny: denied }),
        `vibe-orchestrator: allow ${[...allowed].join(', ')}`,
      ),
    ]
  } catch {
    // The guard installed beside this call enforces the same boundary.
    return []
  }
}

/**
 * Remove mutating tools from one Agent's visible set.
 *
 * Names are filtered against what the Agent can see and can restrict, because
 * `restrict()` rejects an unknown global name outright.
 * @param {object} agent
 * @param {string[]} denied
 * @returns {unknown[]} Disposers for the applied restrictions.
 */
function denyTools(agent, denied) {
  try {
    const visible = new Set(agent.ctx.tools.schemas(scopeOf(agent.ctx)).map((tool) => tool.name))
    const names = denied.filter((tool) => visible.has(tool))
    if (names.length === 0) return []
    return [
      agent.ctx.effect(
        () => agent.ctx.tools.restrict({ deny: names }),
        `vibe-orchestrator: deny ${names.join(', ')}`,
      ),
    ]
  } catch {
    // The guard installed beside this call enforces the same boundary.
    return []
  }
}

export default { name, inject, Config, apply }
