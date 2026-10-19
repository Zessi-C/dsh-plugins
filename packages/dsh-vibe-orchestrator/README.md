# dsh-vibe-orchestrator

A **Vibe** mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh), adapted from the Vibe mode of
[oh-my-pi](https://github.com/can1357/oh-my-pi) (omp).

The main conversation stops doing the work. It becomes the **director**: it reads
the workspace, splits your request into workstreams, and routes each one to a
`fast`, `good`, or `expert` worker. It cannot edit a file or run a command itself.

English | [中文](README.zh.md)

---

## One mode, three tiers

The mode roster lists exactly one entry, **Vibe**. The tiers are workers it
delegates to, not selectable modes.

| Tier | Default route | Tools | Purpose |
|---|---|---|---|
| `fast` | `agent2cli/deepseek-v4.1-flash` | full working toolset | mechanical, well-specified work |
| `good` | `agent2cli/Qwen3.8-Flash` | full working toolset | design, debugging, judgement |
| `expert` | `cpa/gemini-3.8-flash-high` | reads everything, writes new plans | advice on hard problems |

The director keeps reading and routing tools only. `write`, `edit`, `bash`, and
`pwsh` are removed from its visible set *and* blocked by an execution guard, so it
cannot drift into doing the work.

## How it works

One Agent preset, `vibe`, declares the full working tool set, because every worker
inherits that preset. The Host row then shapes each Agent by its role:

| Agent | Persona | Boundary applied |
|---|---|---|
| root session | director | mutating tools removed, three `vibe_*` tools added |
| `fast` worker | fast worker | unchanged |
| `good` worker | good worker | unchanged |
| `expert` worker | expert | `edit`, `bash`, `pwsh` removed |

A worker is an ordinary subagent that inherits the parent's preset, so it differs
only by the model route the tier tool selected and by the boundary above. The tier
is carried on the durable `label` the tool stamps (`expert · …`), so the boundary
still holds for a cold-resumed worker.

Shaping is driven by two events, because a Session can join the preset either way:

- `agent/created` — a Session created with the preset already in its header.
- `agent-preset/selected` — a blank Session switched to the preset afterwards.

Selecting any other preset unwinds everything the row installed.

### Why not Agent Teams

dsh's experimental Agent Teams keeps an **immutable roster**: a member slot is
consumed permanently by the first provisioning record — including a member whose
creation failed — and names are never reused or released. There is no deletion and
no automatic ownership release, and `interrupt_agent` stops a turn without freeing
the slot. Upstream lists nested teams and automatic ownership release as undecided
and uncommitted.

Subagents have none of those limits: capacity is a concurrency bound
(`maxActiveSubagents`, default 8) and each slot returns when the worker settles,
with continuation, `send_message`, and interrupt still available.

### Cost control for the expert tier

The expert has **no call limit and no output limit**. A long-running session must
not run out of consultations, and a truncated expert answer costs more than the
tokens it saves. Cost is bounded by policy instead:

1. **Routing policy** — the director is told to consult the expert only when
   `fast` and `good` cannot settle the problem.
2. **Context isolation** — a spawned worker never inherits the director's
   transcript; it starts with the brief alone.
3. **Scope** — the expert advises and writes plans. It cannot edit code or run a
   command, so an expert turn never turns into an editing session.

### Prompt provenance

The director persona and the tier tool descriptions adapt omp's Vibe mode:
`packages/coding-agent/src/prompts/system/vibe-mode-active.md` and
`packages/coding-agent/src/prompts/tools/vibe-spawn.md`. The director framing, the
worker flavor descriptions, the direction rules, and the duty to verify a worker's
claim by reading the files it touched all come from there.

Four things differ, each deliberately:

| omp | here | why |
|---|---|---|
| two tiers | three | the `expert` advisory tier is this plugin's addition |
| `vibe_send` / `vibe_kill` / `vibe_list` | `send_message` / `interrupt_agent` / `list_agents` | dsh's own worker controls |
| `vibe_wait` | absent | dsh delivers a worker's result as a completion notice |
| director may only `read` | director may also `glob` and `grep` | read-only searching in the parent avoids a worker round trip for every lookup |

## Install

The bundle is self-contained. It resolves the Host's own `@deepseek-ai/*` packages
through `createRequire` on the running Host entry point, so it needs no
`node_modules` of its own and no build step.

```
plugin_manager install_bundle /path/to/dsh-vibe-orchestrator
```

That adds the bundle to the profile's `dsh.profile.bundles` and enables its single
Loader row. Reload the page (or restart the Host) to pick up the settings page.

### Requirements

- dsh `0.2.1-rc.2` (the private `agent-preset` contracts this bundle reads).
- Durable session storage, which every Web profile already mounts.
- The default routes must exist in your composition's provider list; change them
  on the settings page if they do not.

## Settings

**Plugins → Vibe** gives each tier one row with the same two controls the
conversation composer uses:

- a **model menu** over every route the Host advertises, grouped per provider,
  with the current route checked;
- a **thinking-level menu** over the levels the selected model declares, plus
  `Unspecified`, which sends no level and lets the model apply its own.

Nothing is typed by hand. Choosing a model clears a staged level the new model does
not offer. The staged provider and model are written as one revision-fenced
mutation, and every field is `volatile`, so saving applies to the next delegation
with no Host restart.

## Files

| File | Role |
|---|---|
| `lib/index.js` | Host half: tier tools, per-Agent shaping, the volatile routes |
| `lib/copy.js` | Director and worker personas, tier tool descriptions |
| `lib/dsh.js` | Resolves the Host's own `@deepseek-ai/*` packages |
| `lib/client.js` | The **Plugins → Vibe** page |
| `cordis.patch.yml` | The Host row and the single `vibe` preset |

## Differences from omp's Vibe mode

| Aspect | omp | this plugin |
|---|---|---|
| Activation | `/vibe` toggles a live session; blocked while plan or goal mode is on | an Agent preset chosen per Session; plan and goal tools are simply absent |
| Persistence | mode-change event in the session log | the Session header records the preset |
| Director tools | toolset *replaced* by `read` (+ optional `todo`) and five vibe tools; not even `grep` | preset mounts the full set; the row removes the mutating four and adds three tier tools, keeping `glob` and `grep` |
| Tiers | two (`fast`, `good`), differing by bundled agent and model | three, differing by model, persona, and tool boundary |
| Expert advisory tier | none | `expert`, no shell, may write plans |
| Worker reuse | one persistent session per workstream; never respawn | the same rule, stated in the persona and the tool descriptions; `send_message` continues a worker |
| Waiting | `vibe_wait` blocks until a worker's turn ends | none needed: dsh pushes a completion notice |
| Stopping a worker | `vibe_kill` | `interrupt_agent`, which keeps the inbox |
| Mode exit | kills every worker session and tombstones it | capacity returns per worker as it settles; no kill-all needed |
| Route configuration | `modelRoles` / `task.agentModelOverrides` in the config file | a live settings page in the UI |

## Verified and unverified

Verified on dsh `0.2.1-rc.2`:

- the Host row activates, and the mode roster contains exactly one Vibe preset;
- the bundle loads with no `node_modules` beside it;
- the composed preset carries the full working tool set;
- the settings page renders (Host framing, tiers, pickers, Save).

Not verified by the author: the rendered result of the newest picker menus. They
use primitives whose export names and props were checked against the served client
bundle (`Menu`, `MenuGroup`, `MenuItemButton`, `Button`, and the check and chevron
icons), but the authoring environment had no browser control.

## License

MIT
