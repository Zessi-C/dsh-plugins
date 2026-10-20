// One persistent language interpreter, spoken to over NDJSON on stdio.
//
// The design mirrors omp's eval tool (packages/coding-agent/src/eval/py/runner.py)
// in the one respect that matters: the host writes one JSON object per line to
// the child's stdin and reads typed frames back, so interpreter state survives
// across tool calls without any serialization of live objects between them.
//
// Host -> child frames:
//   {"id": "<str>", "code": "<str>"}       execute one cell
//   {"type": "exit"}                       graceful shutdown
//
// Child -> host frames:
//   {"type": "ready", "pid": n, "language": "r"|"py"}
//   {"type": "stdout", "id": ..., "data": "..."}
//   {"type": "stderr", "id": ..., "data": "..."}
//   {"type": "done",   "id": ..., "status": "ok"|"error", "count": n}
//   {"type": "error",  "id": ..., "ename": "...", "evalue": "..."}
//   {"type": "fatal",  "message": "..."}               interpreter died
//
// Confinement: when the caller supplies a `sandbox` descriptor, the interpreter
// is not spawned directly but through the `landlock-run` launcher, which admits
// only the granted filesystem roots. The child then owns exactly the file-effect
// policy dsh applies to its own tools instead of inheriting the host process's
// unrestricted access. A cell can no longer step around a policy by using
// `open()` or `subprocess`: the kernel enforces it on the process itself.

import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_PENDING_OUTPUT = 4 * 1024 * 1024

export class KernelSession {
  constructor({ language, command, args = [], cwd, env, inputMode = 'stdin', sandbox = null, scratchDir = null }) {
    this.language = language
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    // { launcher, grants } for a confined start, or null for a direct spawn.
    // `grants` is the launcher argv up to (not including) the `--` separator.
    this.sandbox = sandbox
    // A private directory this interpreter owns (R's boot-time temp dir); it is
    // removed with the process so a restart does not leave debris behind.
    this.scratchDir = scratchDir

    this.child = null
    this.buffer = ''
    this.pending = new Map()
    this.executionCount = 0
    this.state = 'new' // new | starting | ready | dead
    this.exitInfo = null
    this.starting = null
    // When set, stdout/stderr frames are collected here instead of dropped.
    this.collector = null
    this.queue = Promise.resolve()
    // 'stdin': frames go to the child's stdin pipe (Python reads sys.stdin).
    // 'fifo':  the child reads a named pipe instead. Rscript on Linux cannot
    //          open /dev/stdin, /dev/fd/0 or /proc/self/fd/0 when its stdin is
    //          an anonymous pipe (Node spawn), so R needs a real path.
    this.inputMode = inputMode
    this.fifoDir = null
    this.fifoPath = null
    this.fifoStream = null
  }

  /** Stream and exit handlers are installed exactly once per process. */
  async start(signal) {
    if (this.state === 'ready') return this
    if (this.starting) return this.starting
    this.starting = this.#spawnAndWaitReady(signal)
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  #spawnAndWaitReady(signal) {
    return new Promise((resolve, reject) => {
      let stdinSpec = 'pipe'
      let spawnArgs = this.args
      if (this.inputMode === 'fifo') {
        // A named pipe is a real filesystem path, so an interpreter that
        // cannot reopen an anonymous pipe can still read frames from it.
        this.fifoDir = mkdtempSync(join(tmpdir(), 'dsh-eval-'))
        this.fifoPath = join(this.fifoDir, 'frames.fifo')
        execFileSync('mkfifo', [this.fifoPath])
        stdinSpec = 'ignore'
        spawnArgs = this.args.map((arg) => arg.split('{fifo}').join(this.fifoPath))
      }
      // A confined start goes through the launcher, which applies the grant
      // ruleset and then execs the interpreter: the frames on stdin/stdout are
      // the interpreter's own, so nothing above this line changes.
      const launch = this.sandbox
        ? { command: this.sandbox.launcher, args: [...this.sandbox.grants, '--', this.command, ...spawnArgs] }
        : { command: this.command, args: spawnArgs }
      const child = spawn(launch.command, launch.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: [stdinSpec, 'pipe', 'pipe'],
      })
      this.child = child
      this.state = 'starting'

      if (this.inputMode === 'fifo') {
        // Both ends open asynchronously: the child blocks opening its read end
        // until this write end exists, and Node's stream resolves once it does.
        // Connecting here (not in the ready callback) is what avoids a deadlock,
        // because the ready frame itself arrives through this pipe.
        try {
          this.fifoStream = createWriteStream(this.fifoPath)
          this.fifoStream.on('error', (error) => {
            this.state = 'dead'
            this.fatalMessage = `frame channel failed: ${error.message}`
          })
        } catch (error) {
          fail(error)
        }
      }

      let settled = false
      // Assigned once the abort listener below is installed; defined here so
      // every settle path can call it without a temporal-dead-zone read.
      let detachAbort = () => {}
      let readyTimer
      const settle = (fn, value, state) => {
        if (settled) return
        settled = true
        this.state = state
        detachAbort()
        if (readyTimer) clearTimeout(readyTimer)
        fn(value)
      }
      const fail = (error) => {
        // A start that fails after the pipe was opened would otherwise leave
        // that stream and its directory alive: an open fd keeps the host's
        // event loop from ever draining, which turns one failed spawn into a
        // process that never exits.
        this.#disposeChannels()
        settle(reject, error, 'dead')
      }
      const ok = () => settle(resolve, this, 'ready')

      // Readiness is a frame (`{"type":"ready"}`), not a timeline cue: the
      // wrapper prints it only once its interpreter can accept a cell. R in
      // particular buffers and echoes over a pipe, so "the process spawned" is
      // not the same as "the REPL is ready".
      this.onReadyFrame = ok

      child.on('error', (error) => fail(error))
      child.on('exit', (code, sig) => {
        this.exitInfo = { code, signal: sig }
        this.state = 'dead'
        // Reject everything still outstanding; a dead interpreter cannot answer.
        for (const [, entry] of this.pending) entry.reject(new Error(`interpreter exited (code ${code}, signal ${sig})`))
        this.pending.clear()
        // The launcher's own failures (usage error, unenforcing kernel, grant
        // root it cannot open, failed exec) all exit 125 and say so on stderr.
        // Reporting that instead of a bare exit code is what keeps a policy
        // mistake from reading as "the interpreter crashed".
        const launcherNote = this.sandbox && code === 125 ? ' — the sandbox launcher refused to start the interpreter' : ''
        if (!settled) fail(new Error(`interpreter exited before it was ready (code ${code}, signal ${sig})${launcherNote}`))
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk
        this.#drainFrames()
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        if (this.collector) this.collector.stderr += chunk
      })

      const onAbort = () => {
        // Aborting a start must not abandon a live child: failing the promise
        // alone would leave an interpreter running that nothing can address.
        try {
          child.kill('SIGKILL')
        } catch {}
        fail(new Error('interpreter start aborted'))
      }
      if (signal) {
        if (signal.aborted) {
          fail(new Error('interpreter start aborted'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detachAbort = () => signal.removeEventListener('abort', onAbort)
      }

      readyTimer = setTimeout(() => {
        fail(new Error(`interpreter did not become ready within ${this.readyTimeoutMs ?? 30000}ms`))
        try {
          child.kill('SIGKILL')
        } catch {}
      }, this.readyTimeoutMs ?? 30000)
      child.once('exit', () => clearTimeout(readyTimer))
    })
  }

  #drainFrames() {
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        // Not ours (a stray interpreter banner); treat it as child stderr.
        if (this.collector) this.collector.stderr += line + '\n'
        continue
      }
      this.#handleFrame(frame)
    }
  }

  /**
   * Append streamed output to the current cell, keeping the host's memory
   * bounded. A cell can print without limit, and the collector is the one place
   * that would otherwise hold every byte until the cell ends. Past the budget
   * the middle is dropped and counted: a runaway `print` in a loop then costs a
   * fixed 4 MiB per stream instead of the host's memory. Head and tail are kept
   * because that is what a reader can still use.
   */
  #append(kind, data) {
    const collector = this.collector
    if (!collector) return
    const next = collector[kind] + data
    if (next.length <= MAX_PENDING_OUTPUT) {
      collector[kind] = next
      return
    }
    const half = MAX_PENDING_OUTPUT >> 1
    collector[kind] = next.slice(0, half) + next.slice(-half)
    collector.dropped[kind] += next.length - MAX_PENDING_OUTPUT
  }

  #handleFrame(frame) {
    switch (frame.type) {
      case 'ready':
        this.readyFrame = frame
        this.onReadyFrame?.()
        this.onReadyFrame = null
        return
      case 'stdout':
        this.#append('stdout', frame.data ?? '')
        return
      case 'stderr':
        this.#append('stderr', frame.data ?? '')
        return
      case 'done':
      case 'error': {
        const entry = this.pending.get(frame.id)
        if (!entry) return
        this.pending.delete(frame.id)
        if (typeof frame.count === 'number') this.executionCount = frame.count
        else if (frame.type === 'done') this.executionCount += 1
        if (frame.type === 'done') {
          entry.resolve(this.collector)
        } else {
          // Reject on a later turn. This frame arrives inside the child's
          // 'data' callback, and rejecting there would surface as an unhandled
          // rejection whenever the caller has not yet attached its handler --
          // in a long-lived host that kills the whole process, not just the cell.
          const error = Object.assign(new Error(frame.evalue || 'cell failed'), { ename: frame.ename })
          queueMicrotask(() => entry.reject(error))
        }
        return
      }
      case 'fatal':
        this.state = 'dead'
        this.fatalMessage = frame.message
        return
      default:
        return
    }
  }

  write(frame) {
    if (!this.child || this.state === 'dead') return false
    const line = JSON.stringify(frame) + '\n'
    try {
      if (this.inputMode === 'fifo') {
        if (!this.fifoStream) return false
        this.fifoStream.write(line)
        return true
      }
      this.child.stdin.write(line)
      return true
    } catch {
      return false
    }
  }

  /**
   * Run one cell. Cells are serialized: an interpreter has one state, so a
   * second call must not observe a half-applied first one.
   */
  execute(code, { signal, timeoutMs } = {}) {
    const run = async () => {
      if (this.state === 'dead') {
        throw new Error(this.fatalMessage ?? 'interpreter is not running')
      }
      await this.start(signal)
      if (signal?.aborted) throw new Error('cell aborted before it started')

      const id = randomUUID()
      this.collector = { stdout: '', stderr: '', dropped: { stdout: 0, stderr: 0 } }
      const collector = this.collector

      const result = new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
      })

      const abortHandler = () => {
        const entry = this.pending.get(id)
        if (entry) {
          this.pending.delete(id)
          entry.reject(new Error('cell aborted'))
        }
        // A wedged interpreter cannot be trusted for the next cell; only a
        // fresh process restores a known state.
        this.kill('aborted').catch(() => {})
      }
      if (signal) signal.addEventListener('abort', abortHandler, { once: true })

      let timer
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          const entry = this.pending.get(id)
          if (entry) {
            this.pending.delete(id)
            entry.reject(new Error(`cell timed out after ${timeoutMs}ms`))
          }
          this.kill('timeout').catch(() => {})
        }, timeoutMs)
      }

      try {
        if (!this.write({ id, code })) throw new Error('interpreter is not accepting input')
        await result
        return {
          stdout: clamp(withDropNote(collector.stdout, collector.dropped.stdout)),
          stderr: clamp(withDropNote(collector.stderr, collector.dropped.stderr)),
          executionCount: this.executionCount,
        }
      } finally {
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', abortHandler)
        if (this.collector === collector) this.collector = null
      }
    }

    // Chain on the queue so overlapping calls run one after another.
    const next = this.queue.then(run)
    this.queue = next.catch(() => {})
    return next
  }

  async kill(reason = 'closed') {
    this.state = 'dead'
    this.killReason = reason
    // Release what the dead process was still parked on. Without this a killed
    // interpreter leaves its last partial line and cell output reachable from
    // the map entry until the entry itself is dropped.
    this.buffer = ''
    this.collector = null
    const child = this.child
    if (!child) {
      this.#disposeChannels()
      return
    }
    this.child = null
    // Deferred for the same reason as the error frame path: a synchronous
    // rejection here would become an unhandled rejection when the caller is not
    // awaiting yet, and the host process would die with the interpreter.
    const pending = [...this.pending.values()]
    this.pending.clear()
    const stopError = new Error(`interpreter stopped (${reason})`)
    queueMicrotask(() => {
      for (const entry of pending) entry.reject(stopError)
    })
    try {
      if (this.fifoStream) this.fifoStream.end()
      else if (child.stdin) child.stdin.end()
    } catch {}
    child.kill('SIGTERM')
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 2000)
    await exited
    clearTimeout(timer)
    this.#disposeChannels()
  }

  /**
   * Release everything this interpreter owned outside the process itself: the
   * frame pipe, its directory, and any private scratch directory. Idempotent,
   * because a failed start and a later kill can both reach it.
   */
  #disposeChannels() {
    try {
      this.fifoStream?.end()
    } catch {}
    this.fifoStream = null
    for (const dir of [this.fifoDir, this.scratchDir]) {
      if (!dir) continue
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
    this.fifoDir = null
    this.fifoPath = null
    this.scratchDir = null
  }

  get alive() {
    return this.state === 'ready' || this.state === 'starting'
  }
}

function withDropNote(text, dropped) {
  if (!dropped) return text
  return `${text}\n... [${dropped} characters dropped while streaming] ...\n`
}

function clamp(text) {
  if (text.length <= MAX_PENDING_OUTPUT) return text
  const head = text.slice(0, MAX_PENDING_OUTPUT / 2)
  const tail = text.slice(-MAX_PENDING_OUTPUT / 2)
  return `${head}\n... [output truncated: ${text.length} bytes total] ...\n${tail}`
}
