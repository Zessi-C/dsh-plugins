/**
 * Vibe orchestrator — Host half.
 *
 * One Agent preset, `vibe`, is a Vibe session. Its preset mounts the full working
 * toolset, because every delegated worker inherits it. This Host row then shapes
 * each Agent by its role, which is what produces the mode:
 *
 * | Agent                           | persona      | tools                                                    |
 * |---------------------------------|--------------|----------------------------------------------------------|
 * | root session (the orchestrator)  | orchestrator | read-only; the three `vibe_*` delegation tools           |
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

/** Tools the orchestrator may not run, and the tools the expert may not run. */
const ORCHESTRATOR_DENY = ['write', 'edit', 'bash', 'pwsh']
const EXPERT_DENY = ['edit', 'bash', 'pwsh']

/** Persona role per tier. */
const ROLE_OF_TIER = { fast: 'fast', good: 'good', expert: 'expert' }

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
      const agentOptions = {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      }
      const shortLabel = typeof args?.label === 'string' && args.label.trim().length > 0 ? args.label.trim() : 'task'
      const activation = await subagents.startActivation({
        provider: 'spawn',
        // The tier prefix is how the child's role is recognised again while it is
        // created, and it keeps the roster readable.
        label: `${tier} · ${shortLabel}`.slice(0, 80),
        request: {
          parent,
          agentOptions,
          prompt: [{ type: 'text', text: task }],
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      remember(activation.childId, tier)
      return {
        kind: 'activation',
        subagentId: activation.childId,
        tier,
        model: `${route.provider}/${route.model}`,
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

  ctx.on('agent/created', async ({ agent }) => {
    const header = agent.session?.header
    if (header === undefined) return
    await shape(agent, header.agentPreset)
  })

  // A blank Session switched to Vibe after it was created joins the preset without
  // a second `agent/created`, so the recorded selection drives the same shaping.
  ctx.on('agent-preset/selected', async (sessionId, presetId) => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return
    await shape(agent, presetId)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    shaped.delete(agent.id)
    childTier.delete(agent.id)
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
  disposers.push(...denyTools(agent, ORCHESTRATOR_DENY))
  // A guard is the backstop: it names no registry, so the boundary still holds
  // when a restriction could not be applied.
  disposers.push(
    agent.ctx.effect(
      () =>
        agent.ctx.tools.guard((exec) => {
          if (!ORCHESTRATOR_DENY.includes(exec.name)) return undefined
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
