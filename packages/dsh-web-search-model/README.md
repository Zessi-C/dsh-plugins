# dsh-web-search-model

Adds a **search model** field to the dsh web search settings card — on the
existing card, not as an additional one next to it.

- [The problem](#the-problem)
- [How the card is taken over](#how-the-card-is-taken-over)
- [Maintenance](#maintenance)
- [The model field](#the-model-field)
- [Layout](#layout)
- [Install](#install)
- [Relinking after editing the source](#relinking-after-editing-the-source)
- [Uninstall](#uninstall)
- [Known limitations](#known-limitations)

---

## The problem

The stock settings page, `@deepseek-ai/dsh-client-ui-settings-web-search`, edits
only three fields of the `web-search-deepseek` namespace:

```
apiKeyEnv    credential reference name
baseURL      endpoint
maxUses      max searches per request
```

The provider plugin's own config schema accepts seven fields. The remaining
three — `model`, `apiVersion` and `maxTokens` — are deliberately left as
**composition values** with no entry point in the UI. The upstream package
documents this as a known limitation:

> **Only the namespace's three fields are edited** — the provider's model, API
> version and token budget keep their composition values; this page edits the
> key, the endpoint and the search count only.

`model` is the field most likely to break. The provider defaults to
`deepseek-v4-flash`, an id that self-hosted and third-party Anthropic-compatible
gateways commonly do not serve. Every search is then rejected with HTTP 400 on
the gateway side, while the settings page offers no way to see or change the
field.

## How the card is taken over

Fields **cannot** be injected into the official React component: its children are
hard-coded, and its component instance is unreachable, because the client module
exports only the plugin body while the card component is captured in a factory
closure.

The supported route is the slot mechanism. `plugins.item` is a **list slot
partitioned by id**, and `SlotCore.entriesOfSlot` walks the ledger ordered by
`(priority, order)` keeping the first entry of each cell — so within a single id
the **lowest priority renders**.

```js
// dsh-client-ui-slots / SlotCore.entriesOfSlot
for (const entry of rec.entries) {          // already sorted by priority
  const cell = kind === "list" ? entry.options.id : void 0;
  if (seenCells.has(cell)) continue;        // first entry of the cell wins
  seenCells.add(cell);
  heads.push(entry);
}
```

This package therefore registers with `id: "web-search"` and `priority: -1`. The
official card still registers as usual (at `priority: 0`; a different priority is
not a conflict) but does not render. The slot documentation names this use case
explicitly: *"register at a different priority to shadow it (lowest renders)"*.

### One card, not two

Taking the card over is only half of it. This package is also a bundle, so the
Plugins list shows it and asks the bundle's own page for its configuration through
`plugins.bundle.config`, keyed by the package name. Rendering the form there as
well put the same settings on screen twice: once inside the built-in group and
once under the bundle.

The bundle registration therefore answers with `null`. The settings live on the
shipped card's cell and nowhere else, which leaves exactly one web search card in
the interface while the bundle stays listed and updatable.

### Cost

Taking over the card means the **whole card belongs to this package**. The four
fields are a faithful port of the official client component (`apiKeyEnv` through
the credential domain, `baseURL`, `maxUses`) plus a `model` field. Fields added
or changed upstream will **not** be inherited automatically; after upgrading dsh,
compare against
`@deepseek-ai/dsh-client-ui-settings-web-search/lib/client.js`.

To avoid this cost, return to two separate cards instead: change the `plugins.item`
registration in `lib/client.js` to `id: "web-search-model"`, drop `priority: -1`,
and set `order` to 41. The `plugins.bundle.config` registration then has to render
the form rather than `null`, or the new card would be the only place the settings
appear.

## Maintenance

```sh
python3 check-drift.py
```

The script re-reads every upstream contract this plugin depends on and reports
`ok` / `DRIFT` per item, exiting non-zero when drift is found:

| Check | What breaks if it fails |
|---|---|
| `plugins.item` is still a list slot | Shadowing stops working: two cards, or a registration error |
| `priority` is still written into the entry record | Same |
| `entriesOfSlot` still takes the first entry per id | Same |
| Official card slot id is still `web-search` | The shadowing target moved — two cards appear |
| Official card order is still 40 | Ordering only, harmless |
| Upstream has no field this plugin does not render | A new upstream field would not show on your card |
| Namespace is still `web-search-deepseek` | Saves would be rejected by the host |
| The primitives exports this plugin uses are still present | Card rendering throws |

Point the script at a local `@deepseek-ai` package directory when the default
does not match your install:

```sh
DSH_DS_PACKAGES=/path/to/@deepseek-ai python3 check-drift.py
```

A package the script cannot find is reported as `missing file` and no check runs
for it. Current dsh releases ship `dsh-client-ui-slots` and `dsh-client-ui-primitives`
only inside the built `dsh-web-frontend` bundle, with no `lib/` on disk, so those
two checks report `missing file` there and the rest still pass. Treat that message
as "not checked in this install", not as drift.

**Not covered:** a change to the *behaviour* of an official field whose id stayed
the same (for example, how `apiKeyEnv` is resolved). The script cannot see that;
only a manual diff can.

## The model field

The field is **free text** (`settingsTextField`); the dropdown lists known model
ids as **suggestions** only.

A model id is a property of the **gateway, not of this plugin**. A hard-coded
allow-list would reproduce the very bug this package exists to fix: the gateway
gains a model and the plugin silently goes stale. Any id the gateway accepts is
therefore valid input.

The suggestion list is hard-coded in `KNOWN_MODELS` in `lib/client.js`. Refresh it
whenever the gateway changes:

```sh
curl -s -H "Authorization: Bearer $API_KEY" \
  "$GATEWAY_BASE_URL/models" \
  | python3 -c "import sys,json;print('\n'.join(m['id'] for m in json.load(sys.stdin)['data']))"
```

## Layout

```
package.json          dsh.bundle.patch + dsh.client declarations
cordis.patch.yml      registers the package as an enabled Loader entry (the host half itself has no behaviour)
lib/index.js          host half: an empty apply, present only to hold a Loader entry
lib/client.js         browser half: the actual implementation
check-drift.py        upstream contract check
```

The host half must exist and be empty: `dsh-client-modules` only scans **enabled
Loader entries** when assembling the client startup graph, and that is how the
`./client` path declared under `dsh.client` reaches the browser. This is the same
pattern used by the official settings page.

## Install

```sh
# 1. Register the dependency and the bundle in <profile>/package.json:
#    "dependencies": { "dsh-web-search-model": "file:/path/to/dsh-web-search-model" }
#    "dsh.profile.bundles": [ ..., "dsh-web-search-model" ]

# 2. Install
cd <profile> && pnpm install --prefer-offline

# 3. Confirm the composed result
DSH_HOME=~/.dsh dsh --profile <profile> --dump-config | grep -A2 web-search-model

# 4. Restart the instance — a new module root requires a restart;
#    configuration-only changes are hot-reloaded.
```

## Relinking after editing the source

`pnpm install` writes packages as **hard links**, fixed at install time by
content. After editing anything under `lib/`:

- `pnpm install` → *Already up to date*, does not relink ❌
- `pnpm install --force` → also does not relink ❌
- `rm -rf node_modules/dsh-web-search-model && pnpm install` → ✅ the only reliable way

Without that step the profile's `node_modules` still holds the old content, and
`--dump-config` cannot show the difference (it reads the composition, not the
content). To verify:

```sh
cmp /path/to/dsh-web-search-model/lib/client.js \
    <profile>/node_modules/dsh-web-search-model/lib/client.js && echo same
```

## Uninstall

Remove the two lines from the profile's `dsh.profile.bundles` and `dependencies`,
run `pnpm install`, and restart. The package keeps no persistent state, so nothing
is left behind — the official card returns on its own.

## Known limitations

- Only `model` is added. `apiVersion` and `maxTokens` still have no entry point;
  they rarely need changing, and when they do, edit `cordis.patch.yml` directly.
- The suggestion list is hard-coded and does not follow the gateway
  automatically. See the refresh command above.
- The official card is taken over, so upstream updates are not inherited. See
  [Cost](#cost).
- "Overridden / Reset to default" on the settings page comes from the shared form
  model: saving an empty value returns to the composition layer (the value in
  `cordis.patch.yml`), not to the plugin default.

## License

MIT — see [LICENSE](LICENSE).
