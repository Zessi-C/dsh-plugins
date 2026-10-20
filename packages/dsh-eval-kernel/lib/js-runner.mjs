// Persistent JavaScript kernel speaking NDJSON on stdin/stdout.
//
// Companion to py-runner.py and r-runner.R; frames are documented in
// ../kernel-session.js.
//
// Cells run through `AsyncFunction` so top-level `await` works, which is what
// makes this feel like a REPL rather than a script runner. Module state is kept
// by assigning `import(...)` results into a shared globals object, because ESM
// has no persistent top-level scope to accumulate into.

import { createInterface } from 'node:readline'

const FRAME_OUT = process.stdout

function emit(frame) {
  FRAME_OUT.write(JSON.stringify(frame) + '\n')
}

const state = Object.create(null)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function runCell(code) {
  // A declaration in one cell must be readable in the next. `new Function` has
  // no persistent scope, so the cell runs inside a Proxy-backed `with` block:
  // reads fall through to the state object, and writes land in it. Declarations
  // are rewritten to plain assignments because `const`/`let` would otherwise
  // create block-scoped bindings that vanish with the function call.
  const rewritten = code.replace(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, '$1 =')
  const body = `with (scope) {\n${rewritten}\n}`
  // `has` must answer true only for names this kernel already owns. Returning
  // true unconditionally would shadow `console`, `Promise`, `Error` and every
  // other global with undefined, since the proxy then wins the lookup.
  const scope = new Proxy(state, {
    has: (target, key) => Object.hasOwn(target, key),
    get: (target, key) => (key === Symbol.unscopables ? undefined : target[key]),
    set: (target, key, value) => {
      target[key] = value
      return true
    },
  })
  const runner = new AsyncFunction('scope', body)
  const returned = await runner(scope)
  if (returned !== undefined) console.log(returned)
}

async function main() {
  emit({ type: 'ready', pid: process.pid, language: 'js' })

  let cellCount = 0
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }

    if (frame.type === 'exit') break

    const id = frame.id
    const chunks = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...parts) => chunks.push(parts.map(stringify).join(' '))
    console.error = (...parts) => chunks.push(parts.map(stringify).join(' '))

    let failure = null
    try {
      await runCell(String(frame.code ?? ''))
    } catch (error) {
      failure = error
    } finally {
      console.log = originalLog
      console.error = originalError
    }

    cellCount += 1
    const text = chunks.join('\n')
    if (text) emit({ type: 'stdout', id, data: text })

    // A failed cell still executed, so every reply carries the same count;
    // the error frame simply omits nothing the host needs to reconcile.
    if (failure) {
      emit({
        type: 'error',
        id,
        ename: failure?.name ?? 'Error',
        evalue: String(failure?.message ?? failure),
        traceback: String(failure?.stack ?? '').split('\n'),
        count: cellCount,
      })
    } else {
      emit({ type: 'done', id, status: 'ok', count: cellCount })
    }
  }
}

function stringify(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

main().catch((error) => {
  emit({ type: 'fatal', message: String(error?.message ?? error) })
  process.exitCode = 1
})
