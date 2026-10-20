# dsh-plugins

Private monorepo for the dsh plugins authored for this profile. Keeping them in
one repository means every machine installs from the same place and picks up the
next version with a single update.

| Package | What it does |
| --- | --- |
| [`dsh-eval-kernel`](packages/dsh-eval-kernel) | Persistent Python, R and JavaScript interpreters whose state survives across tool calls, with harness tools callable from inside a cell. |
| [`dsh-plugin-updater`](packages/dsh-plugin-updater) | Finds and applies updates for every plugin of the current profile: npm releases, git-hosted plugins including private repositories, and plugins whose declared dsh range lags behind the running dsh. |
| [`dsh-web-search-model`](packages/dsh-web-search-model) | Adds the provider `model` field the stock web-search settings card leaves as a composition value. |
| [`dsh-vibe-orchestrator`](packages/dsh-vibe-orchestrator) | Vibe mode: the conversation becomes a read-only orchestrator that routes work to fast, good and expert subagents. |

## Install on a new machine

Each package is installed from its directory in this repository. `pnpm` resolves
the git address through your normal credential helper, so a private repository
works once `gh auth login` has been run on that machine.

```sh
dsh plugin --profile web add \
  'git+https://github.com/Zessi-C/dsh-plugins.git#main&path:/packages/dsh-eval-kernel'
dsh plugin --profile web add \
  'git+https://github.com/Zessi-C/dsh-plugins.git#main&path:/packages/dsh-plugin-updater'
dsh plugin --profile web add \
  'git+https://github.com/Zessi-C/dsh-plugins.git#main&path:/packages/dsh-web-search-model'
dsh plugin --profile web add \
  'git+https://github.com/Zessi-C/dsh-plugins.git#main&path:/packages/dsh-vibe-orchestrator'
```

Then add each package name to `dsh.profile.bundles` in the profile's `package.json`
(or switch it on in the Plugins page).

## Update an installation

`dsh-plugin-updater` does this: open **Plugins → 插件更新 / Plugin updates** and
apply the rows it finds, or ask the agent to run `plugin_update`.

The recorded spec follows `main`, so a reinstall picks up the newest commit, and
the version comes from the release tag below.

## Release procedure

The version a private repository publishes cannot be read as a file, so each
package announces its version with a tag named `<package>-v<version>`:

```sh
# 1. bump packages/<name>/package.json
# 2. commit and push main
git commit -am "Release <name> <version>" && git push
# 3. tag that commit
git tag <name>-v<version> && git push origin <name>-v<version>
```

The updater reads the tag set with `git ls-remote --tags`, which uses the same
credentials as the install. A package with no tags still works: the updater then
compares commits instead of version numbers.

## Conventions

- Every package is `private`, MIT licensed, and exports `./icon` plus
  `./locale/*.json` so the Plugins page shows a real title, description and icon.
- Host code reaches Harness internals through the running installation instead of
  a bundled copy, so a package keeps working when installed from git or `link:`.
- `cordis.patch.yml` declares the rows; the package name equals the row's module.
