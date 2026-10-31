# janua guide

Three worked examples of the thing a command runner cannot do: keep a program alive and talk to it.
Tool calls are shown as the arguments you pass and the result you get back; long outputs are
abbreviated.

---

## 1. Restarting a dev server

The first spawn starts the server. Later calls do not start a second one: they write `Ctrl+C` into
the same session and start the command again inside the same shell, so the port is reused and the
environment is identical.

```jsonc
// pty_spawn - a shell, so the session survives the server dying
{
  "command": "cmd.exe",
  "args": ["/d", "/k"],
  "cwd": "C:\\work\\site",
  "title": "site-dev",
  "description": "shell for the site dev server"
}
// -> {"sessionId":"6f1c...","pid":9032,"title":"site-dev"}
```

```jsonc
// pty_write - start it
{"sessionId":"6f1c...","data":"npm run dev"}
// -> {"ok":true}

// pty_read - wait for the first request log
{"sessionId":"6f1c...","cursor":0,"waitMs":10000}
// -> {"data":"\r\n> site@1.0.0 dev\r\n> vite\r\n\r\n  VITE v6.0.0  ready in 214 ms\r\n  ->  Local: http://localhost:5173/\r\n",
//     "cursor":118,"exited":false,"exitCode":null}
```

Restart on the same session - `\u0003` is Ctrl+C, then the same command line:

```jsonc
{"sessionId":"6f1c...","data":"\u0003","newline":false}
{"sessionId":"6f1c...","data":"npm run dev"}

// pty_read from the last cursor shows only what happened since
{"sessionId":"6f1c...","cursor":118,"waitMs":10000}
// -> {"data":"^C\r\n> site@1.0.0 dev\r\n> vite\r\n\r\n  VITE v6.0.0  ready in 187 ms\r\n",
//     "cursor":231,"exited":false,"exitCode":null}
```

Kill it when the work is done. `cmd.exe /k` keeps the shell, so killing the session ends the shell
and the tree under it:

```jsonc
{"sessionId":"6f1c...","signal":"SIGTERM"}
// -> {"ok":true}
```

**Why a shell here.** A session running `npm` directly dies when the server exits and cannot be
restarted in place. A shell session outlives its child, which is what a restart is.

**Running `npm` without a shell.** `pty_spawn` with `"command": "npm"` works too, for a one-shot
command rather than a server you restart: on Windows a bare name is resolved through `PATH` x
`PATHEXT`, and the `npm.cmd` batch shim it finds is started through `cmd /d /s /c`. The arguments
are quoted for that line, so `{"command":"npm","args":["run","build","--","--outDir","my dir"]}`
arrives as five arguments with the space intact.

---

## 2. Answering an interactive prompt

An installer asks a question and exits if nobody answers. `pty_read` shows the question; `pty_write`
answers it. The newline default appends the carriage return the prompt is waiting for.

```jsonc
{"command":"npx","args":["-y","create-something@latest","my-app"],"cwd":"C:\\work","description":"scaffold a new project"}
// -> {"sessionId":"b2a8...","pid":7744,"title":"npx"}

// On Windows npx is a .cmd shim: janua resolves it through PATH x PATHEXT and runs it through
// cmd /d /s /c, so the spawn above works without wrapping it in a shell yourself.

{"sessionId":"b2a8...","cursor":0,"waitMs":5000}
// -> {"data":"Need to install the following packages:\ncreate-something@1.4.0\nOk to proceed? (y) ",
//     "cursor":84,"exited":false,"exitCode":null}

{"sessionId":"b2a8...","data":"y"}          // -> {"ok":true}
{"sessionId":"b2a8...","data":"","newline":true}  // bare Enter, when a default is offered
{"sessionId":"b2a8...","cursor":84,"waitMs":10000}
// -> {"data":"\r\n✔ Project created in C:\\work\\my-app\r\n","cursor":137,"exited":false,"exitCode":null}
```

**Reading the menu.** Options separated by `(y/n)` or `[1] [2]` are answered by one keystroke, but
the program only sees it once Enter arrives - which is why `newline` defaults to true. For a
keystroke that must arrive alone (arrow keys, a TUI), pass `"newline": false`.

**If the answer was wrong,** the session is still alive: answer again rather than spawning another.
Use `pty_kill` only when the program is stuck in a state no input can leave.

---

## 3. Driving a REPL

A REPL keeps state between commands, which is exactly what a one-shot `node -e` cannot do. Keep the
cursor moving so each read shows only the new result.

```jsonc
{"command":"node","args":["--interactive"],"cwd":"C:\\work\\scratch","title":"node-repl","description":"scratch REPL for quick checks"}
// -> {"sessionId":"c91d...","pid":3312,"title":"node-repl"}

{"sessionId":"c91d...","cursor":0,"waitMs":5000}
// -> {"data":"> ","cursor":2,"exited":false,"exitCode":null}

{"sessionId":"c91d...","data":"const xs = [1,2,3].map(n => n * 7)"}
{"sessionId":"c91d...","cursor":2,"waitMs":5000}
// -> {"data":"const xs = [1,2,3].map(n => n * 7)\r\nundefined\r\n> ","cursor":52,...}

{"sessionId":"c91d...","data":"xs"}
{"sessionId":"c91d...","cursor":52,"waitMs":5000}
// -> {"data":"xs\r\n[ 7, 14, 21 ]\r\n> ","cursor":76,...}
```

Note that `xs` still exists in the second command: that is the point of a session. A multi-line
construct (a `function`, an object literal, an `if` block) is entered one line at a time; the REPL
prints `... ` until it is complete.

End it with Ctrl+D (end of input) or kill the session:

```jsonc
{"sessionId":"c91d...","data":"\u0004","newline":false}
{"sessionId":"c91d...","cursor":76,"waitMs":5000}
// -> {"data":"","cursor":76,"exited":true,"exitCode":0}
```

---

## Rules of thumb

- One session per long-lived thing. Spawn once, talk many times, kill once.
- Always pass the `cursor` a read returned. Reading from 0 again re-delivers everything still
  buffered, which is useful for a full dump and wasteful for a diff.
- `waitMs` beats sleeping between reads: it returns the moment output arrives.
- Keep `description` meaningful (5-10 words). It is what makes a list of sessions readable later.
- Kill what you started. A session lives until it exits or the server does.
- 16 sessions is the default cap; `too_many_sessions` means kill one first.
