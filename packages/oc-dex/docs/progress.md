# Progress display

`oc_dex` reports progress with `context.progress`, and the payload is ours to shape. It is
small by default and gets louder only when asked.

## Modes

| `progress` | Status line | Model in title | Event-driven updates |
|---|---|---|---|
| `quiet` | `<phase> · 12s` | no | none; the heartbeat alone keeps the clock moving |
| `concise` (default) | `<phase> · 12s` | no | phase changes only |
| `detailed` | `<phase> · <detail> · 12s` | yes | every controller event, throttled to 4/s |

The elapsed clock is in every mode and the heartbeat never stops, so the payload always
carries movement. What that means on screen is another matter: the terminal UI does not paint
progress metadata for a custom tool (see below), so while a run is going there the only
visible signal is the host's own running state and the `oc_dex` row it opened. Nothing the
model writes at length enters the line unless the mode is `detailed`, and `detailed` caps the
detail at 120 characters and one line.

The heartbeat fires every `heartbeatSeconds` (default 10). `formatProgress` floors the clock
at zero and prints it once, so a status line cannot read `12s · 12s`.

## Knobs

Put a `oc-dex.config.json` beside `package.json` in the plugin folder — no `opencode.jsonc`
entry needed:

```json
{
  "progress": "detailed",
  "heartbeatSeconds": 30
}
```

Precedence: `plugins[].options` in `opencode.json(c)` beats the file, the file beats the
defaults. Same keys either way:

| Key | Values | Default |
|---|---|---|
| `progress` | `quiet`, `concise`, `detailed` | `concise` |
| `heartbeatSeconds` | integer 1–300 | `10` |

`0` is refused: a still row is worse than a slow one. A file that is not a JSON object, or a
mode that is not listed above, fails at plugin setup instead of degrading silently.

## What the TUI actually draws

On OpenCode 2.3.0 the terminal UI renders a tool row from the tool name plus its input
summary (`⚙ oc_dex [prompt=…, model=…]`), the tool's output, and a final duration. It reads
`metadata` only for tool names it ships a renderer for (`shell`, `read`, `edit`, `subagent`,
and so on), so a custom tool's progress metadata is stored on the part and not painted. The
plugin's own visible contribution during a run is therefore the row the host draws when the
call starts; the progress stream is for clients that do render it, and for the permission
prompt. Keep it lean anyway: each update is a session event and a re-render.
