# dsh-plugin-updater

Detects and applies updates for the plugins of the current dsh profile.

It covers the three cases a dsh profile actually runs into:

| Situation | What the page shows | What "update" does |
| --- | --- | --- |
| A registry plugin has a newer release | installed → latest | installs the newest release that **declares support for the running dsh** |
| A plugin is installed from a git repository (including a private GitHub one) | remote HEAD and its manifest | reinstalls from the recorded remote |
| A plugin still works but its `engines.dsh` / dsh peer range is behind | the unmet requirement | installs a newer release that fits, or widens the declared range in place |

A linked local checkout (`file:` / `link:`) is never probed over the network. The page reports it as local and the Host reports whether its sources are newer than its build output, since a stale build silently keeps old code running.

## Use it

**Plugins page → 插件更新 / Plugin updates tab.** The tab lists every bundle grouped by state:

- **Updates** — a newer compatible release exists.
- **Not compatible** — the installed version does not satisfy the running dsh. A plugin whose newest release exceeds the runtime offers two actions: update to the newest release that *does* fit, or record the exact-version exemption.
- **Local** — linked directory.
- **Up to date**, **Unreadable**, **Shipped with dsh** (built into dsh; updated with dsh itself).

Select rows and press **应用所选 / Apply selected**. Each row is installed through the plugin manager's own API (`installBundle`), so pnpm, build-script policy, the lockfile and the profile patch stay the Harness's business. A reinstall re-derives the dependency spec, the bundle selection and the row toggles from the new package, so this plugin restores all three afterwards.

**Agent tool.** `plugin_update` with `action: "check"` prints the report; `action: "apply"` runs a plan. Applying is refused unless the plugin's config sets `agentToolMirrorsPlan: true`, because a plugin update replaces code the user is running.

## How the dsh-range case is handled

The Harness refuses to load a plugin whose declared dsh requirement the runtime does not satisfy (`dsh-app-boot` → `evaluatePluginCompatibility`). There are exactly two honest ways out:

1. **Move to a release that accepts the runtime.** Every release in the packument is screened against `semver.satisfies(runtime, range, { includePrerelease: true })` — the same call the Harness makes — and the newest compatible one is installed.
2. **Accept the risk for this exact version.** When no release declares the runtime, the user's confirmation becomes the Harness's own record: `${name}@${version}` → `[runtime]` in the profile's `compatibility.json`, the same entry `dsh plugin allow-version` writes.

When the release is already current and only the range lags, the installed manifest's `engines.dsh` (or the dsh peer range) gets `|| <runtime>` appended. That keeps code that demonstrably works working, and the change is visible in the installed manifest rather than hidden in a profile override.

## Configuration

Set on the `plugin-updater` row in the profile's `cordis.patch.yml`:

| Field | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `30000` | Per-request timeout for registry and git probes. |
| `probe` | `true` | `false` reports the plugin table without network access. |
| `fallbackRegistry` | `https://registry.npmjs.org/` | Registry asked when the profile's pnpm registry does not answer. |
| `agentToolMirrorsPlan` | `false` | Let `plugin_update action: "apply"` change plugins. |

## Requirements and limits

- `git` on PATH for git-hosted plugins. A private GitHub repository works when `gh auth login` configured git's credential helper; otherwise the row says so.
- Build scripts blocked by pnpm surface as a failure naming the packages; approve them in `pnpm-workspace.yaml` and retry, as the Plugins page does.
- Restart dsh when the page reports `restart-required`: a new module generation is not loaded in place.
- A plugin shipped with the installation is never overwritten — that would shadow the shipped copy.

MIT licensed.
