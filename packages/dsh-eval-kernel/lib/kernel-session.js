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
import { Socket } from 'node:net'
import { mkdtempSync, rmSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_PENDING_OUTPUT = 4 * 1024 * 1024

/**
 * Teach a child-stream's writable side to report backpressure.
 *
 * A stdio pipe to a spawned process is a libuv stream: its `write()` hands the
 * bytes to the kernel and reports `false` every time, and `writableLength`
 * stays at 0. Node's event-loop write queue is only reachable through a
 * `net.Socket`, so the same descriptor is also handed to one. When a cell's
 * code does not fit in the pipe buffer, the writer then waits for the child
 * to drain it instead of piling the rest into the host's memory.
 * @param stream - the child's stdin (a pipe to write to), or its frame pipe.
 * @param fd - the descriptor that stream writes to.
 * @returns the socket now carrying this stream's writes, or null when the
 *   stream has no descriptor to adopt (then writes stay unbounded).
 */
function applyBackpressure(stream, fd = stream.fd) {
  if (fd === undefined || fd === null) return null
  const socket = new Socket({ fd, readable: false, writable: true })
  // The wrapped stream owns the error surface; an unhandled 'error' on the
  // socket would take the host process down with it.
  socket.on('error', () => {})
  stream._write = (chunk, encoding, callback) => socket.write(chunk, callback)
  stream._final = (callback) => {
    socket.end()
    callback()
  }
  return socket
}

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
    // One-shot recovery after a cell was lost on the write side (aborted or
    // timed out while its frame was still being written). The next call gets a
    // fresh interpreter instead of writing into a stream whose callback queue
    // never drains.
    this.restartOnNextCell = false
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

      if (stdinSpec === 'pipe' && child.stdin) {
        // Frames go to the child through this stream. Without the socket the
        // host cannot tell that the child stopped reading, and a large cell
        // would be buffered in the host's memory instead.
        this.stdinSocket = applyBackpressure(child.stdin, child.stdin._handle?.fd)
      }

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
          // The fifo's directory may still be being created, so the stream has
          // no descriptor yet; the socket is attached once it opens.
          this.fifoStream.once('open', (fd) => {
            this.fifoSocket = applyBackpressure(this.fifoStream, fd)
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
        // The interpreter's own diagnostics — a Python SyntaxWarning, R's
        // `message()`, a segfault note — arrive here rather than as frames.
        // Dropping them on the floor is what made a failing cell look like a
        // silent one, so they are folded into the cell's stderr and capped
        // like streamed output.
        this.#append('stderr', chunk)
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
    this.#appendTo(collector, kind, data)
  }

  #appendTo(collector, kind, data) {
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
        if (!entry) {
          // An answer to a cell the host gave up on: nobody is waiting for it,
          // and kill() may already have moved on to a different interpreter.
          return
        }
        this.pending.delete(frame.id)
        if (typeof frame.count === 'number') this.executionCount = frame.count
        else if (frame.type === 'done') this.executionCount += 1
        if (frame.type === 'done') {
          entry.resolve(this.collector)
        } else {
          // The child already sent the formatted traceback as stderr frames;
          // a Python detail line carries no trailing newline on its own.
          if (this.collector === entry.collector && this.collector.stderr && !this.collector.stderr.endsWith('\n')) {
            this.collector.stderr += '\n'
          }
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
      if (this.restartOnNextCell) {
        // The previous cell was abandoned while its frame was still being
        // written; this stream can no longer be trusted to drain, so the
        // interpreter is replaced before anything is sent.
        await this.kill('recovering from an interrupted cell').catch(() => {})
        throw new Error('interpreter was restarted because the previous cell did not finish cleanly; run the cell again')
      }
      await this.start(signal)
      if (signal?.aborted) throw new Error('cell aborted before it started')

      const id = randomUUID()
      this.collector = { cellId: id, stdout: '', stderr: '', dropped: { stdout: 0, stderr: 0 } }
      const collector = this.collector

      const result = new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, collector })
      })

      // Set once the frame has been handed over in full. Before that point
      // there is nothing to interrupt, and killing the child would strand the
      // partially written line in a dead process: the interpreter itself is
      // fine and its variables must survive an abort.
      let dispatched = false
      const abandon = (error, reason) => {
        const entry = this.pending.get(id)
        if (entry) {
          this.pending.delete(id)
          entry.reject(error)
        }
        if (!dispatched) {
          // The frame may be half written, or not written at all. Runaway
          // writes are caught by the event-loop write queue, so dropping the
          // cell here means the stream can be left mid-write — only a new
          // process restores a known state.
          this.restartOnNextCell = this.writeQueueFull()
        }
        // A wedged interpreter cannot be trusted for the next cell; only a
        // fresh process restores a known state.
        this.kill(reason).catch(() => {})
      }

      const abortHandler = () => abandon(new Error('cell aborted'), 'aborted')
      if (signal) signal.addEventListener('abort', abortHandler, { once: true })

      let timer
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => abandon(new Error(`cell timed out after ${timeoutMs}ms`), 'timeout'), timeoutMs)
      }

      try {
        if (!this.write({ id, code })) throw new Error('interpreter is not accepting input')
        dispatched = true
        await result
        return {
          stdout: clamp(withDropNote(collector.stdout, collector.dropped.stdout)),
          stderr: clamp(withDropNote(collector.stderr, collector.dropped.stderr)),
          executionCount: this.executionCount,
        }
      } finally {
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', abortHandler)
        // The collector may have moved on: a replaced interpreter tags its
        // cells' frames with their own collector, so only ours is released.
        if (this.collector === collector) this.collector = null
      }
    }

    // Chain on the queue so overlapping calls run one after another. The tail
    // must swallow both outcomes: an unhandled rejection here is a host
    // process death, not just a failed cell.
    const next = this.queue.then(run)
    this.queue = next.then(
      () => {},
      () => {},
    )
    return next
  }

  /** Whether the write side still holds bytes the child has not taken yet. */
  writeQueueFull() {
    const socket = this.stdinSocket ?? this.fifoSocket
    if (socket && socket.writableLength > 0) return true
    for (const stream of [this.child?.stdin, this.fifoStream]) {
      if (stream && stream.writableLength > 0) return true
    }
    return false
  }

  async kill(reason = 'closed') {
    this.state = 'dead'
    this.killReason = reason
    this.restartOnNextCell = false
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
    this.fifoSocket = null
    // The socket owns a descriptor of its own; leaving it open keeps the
    // host's event loop alive after the interpreter is gone.
    this.stdinSocket?.destroy()
    this.stdinSocket = null
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
