# dsh-eval-kernel

Persistent Python, R and JavaScript interpreters for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), running under the session's own file-effect policy.

An agent normally reaches a computation through `bash`, which means every intermediate value has to cross a shell boundary as text and go through a file to survive the next call. This plugin registers one `run_cell` tool that keeps an interpreter alive per `(agent, language)` pair, so a DataFrame, a fitted model, or a Seurat object stays in memory between calls.

English | [中文](README.zh.md)

## What it does

- **Persistent state.** Variables, imports and loaded data survive across tool calls. `reset: true` starts a clean interpreter.
- **Three languages.** `py` (Python), `r` (R), `js` (JavaScript). R is an addition over omp's `eval`, whose backend enum is `py` and `js` only.
- **Confined.** Each interpreter starts under the file-effect policy of the session that asked for it, so a cell cannot read or write its way around what the harness already forbids. Confinement is inherited by anything a cell spawns.
- **Policy follows the conversation.** The policy is re-read on every call; if it changed, the interpreter is restarted under the new one instead of keeping revoked limits for the rest of its life.
- **Failure is not fatal.** A cell that raises returns its traceback and leaves the interpreter alive; the next cell continues from the same state.
- **Per-agent isolation.** Two agents never share interpreter state.
- **Bounded memory.** Streamed output is capped while it is collected, and an idle interpreter is reclaimed rather than kept forever.

## Install

From this monorepo:

```sh
dsh plugin --profile web add github:Zessi-C/dsh-plugins#main\&path:/packages/dsh-eval-kernel
```

Then restart the harness so the new module generation loads.

## Usage

The agent calls `run_cell` with `code` and an optional `language`:

```json
{"code": "import pandas as pd\ndf = pd.read_csv('data.csv')\nprint(df.shape)", "language": "py"}
```

and in a later call:

```json
{"code": "print(df.describe())", "language": "py"}
```

`df` is still there. Arguments: `code` (required), `language`, `title`, `reset`, `timeoutMs`.

## Confinement

The interpreter is not spawned directly: it is started through dsh's `landlock-run` launcher with a grant list derived from the session policy. Reads are allowed everywhere (`/`); writes are allowed only where the policy allows them — the workspace root and `/tmp` for `workspace-write`, nothing at all for `read-only`, plus `/dev/null` in both cases because a process that cannot open it fails for reasons unrelated to policy.

Two properties matter more than the list:

- **It is the policy of the call, not of the plugin.** The policy is resolved per call from `ctx.sandboxPolicy.resolve({ session })`. When a conversation's mode changes — the user widens or narrows it, an escalation is approved — the signature changes and the interpreter is replaced, because a landlock ruleset cannot be relaxed after `exec`. The cell's stderr says so, so a model is never silently handed an empty namespace.
- **It is enforced by the kernel, not by discipline.** The ruleset is inherited across `fork`/`exec`, so a cell that shells out with `subprocess` or `system()` stays inside it. There is no in-process escape hatch, and no host-tool bridge that a cell could use to reach one.

`danger-full-access` is passed through unconfined: the point of that mode is that nothing is withheld, and narrowing it here would quietly break it.

If confinement was asked for and cannot be delivered, the call fails instead of degrading: an interpreter that looks confined and is not is worse than one that refuses to start. Set `sandbox: false` to run the kernel itself until it is fixed (it removes the confinement — only for debugging).

> **Platform note.** Confinement needs the `landlock-run` launcher, which ships for Linux. On a host where its functional probe reports the launcher unusable, `run_cell` refuses to start; `sandbox: false` is the explicit opt-out.

### R's scratch directory

`Rscript` creates a session temp directory while booting, so under `read-only` it exits before it can accept a cell. R therefore gets a private scratch directory in every mode: created by the plugin, granted on its own (never `/tmp` as a whole), exported as `TMPDIR`, and removed with the interpreter. It is the narrowest way to keep R usable without widening the policy.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `pythonBinary` | `python3` | Interpreter for `py` |
| `rBinary` | `Rscript` | Interpreter for `r` |
| `jsBinary` | `node` | Interpreter for `js` |
| `defaultLanguage` | `py` | Language when a call omits `language` |
| `timeoutMs` | `300000` | Per-cell budget; `0` disables the deadline |
| `maxOutputChars` | `30000` | Characters of output kept before truncating to head and tail |
| `sandbox` | `true` | Confine interpreters to the session policy; `false` runs them with the host's own access |
| `idleTimeoutMs` | `1800000` | Reclaim an idle interpreter after this long; `0` keeps it |

Point `rBinary` at a conda environment's `Rscript` when a project needs a specific R version.

## Memory and lifecycle

An interpreter is a process holding whatever the last cell put in it, so its lifetime is managed explicitly:

- **Output is capped while it streams.** A `print` in a loop is the easy way to make the host hold gigabytes. Each stream keeps 4 MiB (head and tail) and counts what it dropped, so a runaway print costs a fixed budget. The interpreter's own stderr (a Python warning, R's `message()`) is folded into the same cell stderr instead of being discarded.
- **A slow reader is waited for, not buffered.** A cell frame that does not fit in the pipe buffer now makes the host wait for the interpreter to drain it, instead of queueing the rest in the host's memory.
- **Idle interpreters are reclaimed.** After `idleTimeoutMs` the process is killed and its memory returned. The next call starts a fresh one and says so in stderr rather than silently handing back an empty namespace. A session with a cell still running is never reclaimed: the sweep only looks at interpreters that finished their last cell that long ago.
- **A dead interpreter is replaced.** Crashed, aborted or timed-out processes are restarted on the next call instead of poisoning every later cell. A timeout or a cancelled call therefore loses the interpreter's variables, and `run_cell` says so in its error rather than reporting a bare rejection.
- **`reset: true`** discards the interpreter by request, which is the way to drop a large object you no longer need.
- **Teardown releases the pipes.** A failed start closes its frame pipe and removes any directory it created; an unclosed pipe would keep the host's event loop alive forever.

## Implementation notes

- Each interpreter is a child process spoken to over NDJSON. The host writes one JSON object per line; the child answers with typed frames (`stdout`, `stderr`, `error`, `done`).
- **R needs a named pipe.** `Rscript` on Linux cannot reopen `/dev/stdin`, `/dev/fd/0` or `/proc/self/fd/0` when its stdin is an anonymous pipe, so the R child reads a per-session FIFO created in a temp directory and removed on teardown.
- **R captures output in memory.** Cell output is redirected with `sink()` into a `textConnection` rather than a temp file, so the kernel still works when the policy grants no writable directory. Frames are written through a connection handle captured before any `sink()`, so the two do not interfere; a cell that leaves its own `sink()` open has it unwound before the next frame, so one careless cell cannot swallow every later answer.
- **Python state is explicit.** Cells run via `compile()`/`exec()` against one namespace dict — no IPython dependency, so any interpreter works.
- **JavaScript uses a proxy scope.** Declarations are rewritten to plain assignments and resolved through a `with` block over a proxy that answers `has` only for names the kernel already owns, which keeps globals like `console` and `Error` visible.
- The tool is declared through the harness's `defineTool`, which compiles the schema DSL into the standard JSON Schema an OpenAI-compatible endpoint expects. Hand-building the definition leaves `parameters` as a bare property map and the endpoint rejects it with `invalid function call parameters` (`upstream_code: 11129`).
- Errors are rejected on a later turn (`queueMicrotask`). Rejecting inside the child's `data` callback produces an unhandled rejection when the caller has not attached a handler yet, which kills the host process rather than the cell.

## Migrating from 0.1.0

0.1.0 let a cell call harness tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`) as plain functions, through a host bridge. That has been removed, for the reason above: the bridge policed individual calls while the interpreter itself was unconfined, so it suggested a boundary it could not enforce — any cell could step around it with `open()`.

The replacement is stronger and needs no configuration: the whole interpreter runs under the policy, so plain file I/O inside a cell is already governed. `bridgeTools` is gone; a config that still lists it is ignored. If a cell needs something the policy forbids, use `bash` (or raise the mode) rather than reaching for an in-cell bridge.

## License

MIT
