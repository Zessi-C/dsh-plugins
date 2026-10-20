# dsh-eval-kernel

Persistent Python, R and JavaScript interpreters for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with cells that can call the harness's own tools.

An agent normally reaches a computation through `bash`, which means every intermediate value has to cross a shell boundary as text and go through a file to survive the next call. This plugin registers one `run_cell` tool that keeps an interpreter alive per `(agent, language)` pair, so a DataFrame, a fitted model, or a Seurat object stays in memory between calls.

English | [中文](README.zh.md)

## What it does

- **Persistent state.** Variables, imports and loaded data survive across tool calls. `reset: true` starts a clean interpreter.
- **Three languages.** `py` (Python), `r` (R), `js` (JavaScript). R is an addition over omp's `eval`, whose backend enum is `py` and `js` only.
- **Tool callbacks.** Inside a cell, harness tools are callable as plain functions — `read`, `write`, `edit`, `bash`, `grep`, `glob` by default. So a cell can read a CSV through the same `read` the model uses, or spawn a subagent mid-computation.
- **Failure is not fatal.** A cell that raises returns its traceback and leaves the interpreter alive; the next cell continues from the same state.
- **Per-agent isolation.** Two agents never share interpreter state.

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

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `pythonBinary` | `python3` | Interpreter for `py` |
| `rBinary` | `Rscript` | Interpreter for `r` |
| `jsBinary` | `node` | Interpreter for `js` |
| `defaultLanguage` | `py` | Language when a call omits `language` |
| `timeoutMs` | `300000` | Per-cell budget; `0` disables the deadline |
| `maxOutputChars` | `30000` | Characters of output kept before truncating to head and tail |
| `bridgeTools` | `read, write, edit, bash, grep, glob` | Harness tools exposed to cells |
| `idleTimeoutMs` | `1800000` | Reclaim an idle interpreter after this long; `0` keeps it |

Point `rBinary` at a conda environment's `Rscript` when a project needs a specific R version.

## Implementation notes

- Each interpreter is a child process spoken to over NDJSON. The host writes one JSON object per line; the child answers with typed frames (`stdout`, `stderr`, `error`, `done`, and `tool` for callbacks).
- **R needs a named pipe.** `Rscript` on Linux cannot reopen `/dev/stdin`, `/dev/fd/0` or `/proc/self/fd/0` when its stdin is an anonymous pipe, so the R child reads a per-session FIFO created in a temp directory and removed on teardown.
- **R frames bypass `sink()`.** Cell output is captured by redirecting the R stdout connection to a temp file, but frames are written through a connection handle captured before any `sink()`, so the two do not interfere.
- **Python state is explicit.** Cells run via `compile()`/`exec()` against one namespace dict — no IPython dependency, so any interpreter works.
- **JavaScript uses a proxy scope.** Declarations are rewritten to plain assignments and resolved through a `with` block over a proxy that answers `has` only for names the kernel already owns, which keeps globals like `console` and `Error` visible.
- The tool is declared through the harness's `defineTool`, which compiles the schema DSL into the standard JSON Schema an OpenAI-compatible endpoint expects. Hand-building the definition leaves `parameters` as a bare property map and the endpoint rejects it with `invalid function call parameters` (`upstream_code: 11129`).
- Errors are rejected on a later turn (`queueMicrotask`). Rejecting inside the child's `data` callback produces an unhandled rejection when the caller has not attached a handler yet, which kills the host process rather than the cell.

## License

MIT
