# Persistent R kernel speaking NDJSON on stdin/stdout.
#
# Companion to py-runner.py; frames are documented in ../kernel-session.js.
# omp's eval has no R backend, so this file is the reason the plugin exists.
#
# Why a dedicated readLines() loop rather than R's default REPL: R only prompts
# and flushes correctly on a terminal. Over a pipe the default front end buffers
# and echoes, which makes "is this cell finished" undecidable from the host. A
# loop that owns its own prompt gives an unambiguous ready/finished boundary.
#
# Only jsonlite is required for tool replies; the rest is base R. When jsonlite
# is absent the kernel still runs cells, and `bridge()` (host tool calls) degrades
# to a clear error instead of a silent misparse.

# Frames need their own handle on fd 1. Two traps this avoids:
#   * `file("stdout")` opens a *disk file* named stdout, not the stream.
#   * `stdout()` IS the connection sink() replaces, so frames written during a
#     cell's sink() would be swallowed along with the cell's own output.
# A raw connection to /dev/fd/1 survives sink() because sink() swaps the stdout
# text connection, not the underlying descriptor.
#
# stdin has a third trap specific to `Rscript file.R`: after loading the script,
# R may still treat the remaining stdin as more script to evaluate, so
# readLines(stdin()) consumes the runner's own source. Opening /dev/stdin
# directly bypasses that path. Both /dev links are pipes, so R warns that it
# falls back to raw mode; that warning is expected and suppressed.
#
# fd 1 is often an anonymous pipe (Node spawn, in particular), where /dev/fd/1
# is not openable at all. Holding the stdout() connection from before any
# sink() keeps frames flowing during a cell: writing THROUGH that saved
# connection bypasses the sink, while the cell's own cat() goes into it.
#
# stdin: `Rscript file.R` may treat leftover stdin as more script to evaluate,
# and an anonymous pipe (Node spawn) is not openable through /dev/stdin or
# /proc/self/fd/0 at all. The host therefore passes a named pipe path as the
# first argument, which is a real path R can open like any file.
FRAME_CON <- stdout()
if (length(commandArgs(trailingOnly = TRUE)) < 1L) {
  stop("usage: Rscript r-runner.R <frames-fifo-path>")
}
STDIN_CON <- file(commandArgs(trailingOnly = TRUE)[1], open = "r", blocking = TRUE)

emit_frame <- function(frame) {
  if (requireNamespace("jsonlite", quietly = TRUE)) {
    payload <- jsonlite::toJSON(frame, auto_unbox = TRUE, null = "null", na = "null")
  } else {
    payload <- simple_json(frame)
  }
  cat(payload, "\n", sep = "", file = FRAME_CON)
  flush(FRAME_CON)
}

# Base R has no JSON writer, so a minimal encoder covers the case where the host
# answers a bridged tool call before any package could be loaded.
simple_json <- function(x) {
  if (is.null(x) || length(x) == 0L) return("null")
  if (is.list(x)) {
    if (!is.null(names(x))) {
      parts <- vapply(seq_along(x), function(i) {
        paste0(simple_json(names(x)[i]), ":", simple_json(x[[i]]))
      }, character(1))
      return(paste0("{", paste(parts, collapse = ","), "}"))
    }
    return(paste0("[", paste(vapply(x, simple_json, character(1)), collapse = ","), "]"))
  }
  if (length(x) != 1L) return(simple_json(as.list(x)))
  if (is.na(x)) return("null")
  if (is.character(x)) {
    escaped <- gsub("\\", "\\\\", x, fixed = TRUE)
    escaped <- gsub("\"", "\\\"", escaped, fixed = TRUE)
    escaped <- gsub("\n", "\\n", escaped, fixed = TRUE)
    escaped <- gsub("\r", "\\r", escaped, fixed = TRUE)
    escaped <- gsub("\t", "\\t", escaped, fixed = TRUE)
    return(paste0("\"", escaped, "\""))
  }
  if (is.logical(x)) return(if (x) "true" else "false")
  if (is.numeric(x)) {
    if (!is.finite(x)) return("null")
    return(format(x, scientific = FALSE, digits = 15L, trim = TRUE))
  }
  simple_json(as.character(x))
}

# --- host tool bridge -------------------------------------------------------

bridge_call <- function(name, args = list()) {
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("jsonlite is required for host tool calls; install.packages('jsonlite')")
  }
  request_id <- paste0("tool-", sample.int(.Machine$integer.max, 1L))
  emit_frame(list(type = "tool", id = request_id, name = name, args = args))

  repeat {
    line <- readLines(STDIN_CON, n = 1L, warn = FALSE)
    if (length(line) == 0L) stop("host closed the bridge")
    frame <- tryCatch(jsonlite::fromJSON(line, simplifyVector = FALSE), error = function(e) NULL)
    if (is.null(frame)) next
    if (identical(frame$type, "exit")) quit(save = "no", status = 0)
    if (!identical(frame$type, "reply") || !identical(frame$id, request_id)) next
    if (!is.null(frame$error)) stop(frame$error)
    return(frame$value)
  }
}

install_bridge <- function(names) {
  for (tool_name in names) {
    if (nzchar(tool_name) && !exists(tool_name, inherits = FALSE)) {
      local({
        target <- tool_name
        assign(target, function(...) bridge_call(target, list(...)), envir = globalenv())
      })
    }
  }
}

# --- cell loop --------------------------------------------------------------

# Tell the host the interpreter is loaded and can accept a cell. Nothing runs
# before this frame, which is what makes "process spawned" distinguishable from
# "REPL ready" over a pipe.
emit_frame(list(type = "ready", pid = Sys.getpid(), language = "r"))
install_bridge(strsplit(Sys.getenv("DSH_EVAL_BRIDGE_TOOLS", ""), ",", fixed = TRUE)[[1]])

# Feed one line to R's parser and report whether it is a complete expression.
# R's own REPL decides continuation by catching an "unexpected end of input"
# parse error, which is what makes multi-line for/if/function blocks work.
source_state <- function(text) {
  parsed <- tryCatch(parse(text = text), error = function(e) e)
  if (inherits(parsed, "error")) {
    message <- conditionMessage(parsed)
    if (grepl("unexpected end of input", message, fixed = TRUE) ||
        grepl("unexpected INCOMPLETE_STRING", message, fixed = TRUE)) {
      return(list(status = "incomplete"))
    }
    return(list(status = "error", error = parsed))
  }
  list(status = "complete", expressions = parsed)
}

cell_count <- 0L
repeat {
  line <- readLines(STDIN_CON, n = 1L, warn = FALSE)
  if (length(line) == 0L) break
  if (!nzchar(line)) next

  parsed <- tryCatch(
    if (requireNamespace("jsonlite", quietly = TRUE)) jsonlite::fromJSON(line, simplifyVector = TRUE) else NULL,
    error = function(e) NULL
  )
  if (is.null(parsed) || !is.list(parsed)) next
  if (identical(parsed$type, "exit")) break
  if (identical(parsed$type, "tool")) next

  cell_id <- parsed$id
  out_file <- tempfile()
  sink_handle <- file(out_file, open = "w")
  sink(sink_handle, split = FALSE)
  status <- "ok"
  error_frame <- NULL

  result <- tryCatch(
    {
      state <- source_state(parsed$code)
      if (identical(state$status, "incomplete")) {
        stop("incomplete expression: the cell ended mid-block")
      }
      if (identical(state$status, "error")) stop(state$error)
      for (expression in state$expressions) {
        value <- withVisible(eval(expression, envir = globalenv()))
        if (value$visible) print(value$value)
      }
      NULL
    },
    error = function(e) e
  )
  sink()
  close(sink_handle)

  captured <- tryCatch(paste(readLines(out_file, warn = FALSE), collapse = "\n"), error = function(e) "")
  unlink(out_file)

  # Any bare cat() a cell made went to the frame channel; keep it out of stdout
  # by redirecting only when the cell itself asked for output. The collector
  # reports it as stdout either way.
  if (nzchar(captured)) {
    emit_frame(list(type = "stdout", id = cell_id, data = captured))
  }
  cell_count <- cell_count + 1L

  if (!is.null(result)) {
    status <- "error"
    error_frame <- list(
      type = "error", id = cell_id,
      ename = "RError", evalue = conditionMessage(result), traceback = character(0)
    )
    emit_frame(error_frame)
  } else {
    emit_frame(list(type = "done", id = cell_id, status = status, count = cell_count))
  }
}
