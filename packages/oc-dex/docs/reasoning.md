# Reasoning effort

`oc_dex` accepts an optional Codex reasoning effort — for example `xhigh` — and sends
it on the one protocol channel that supports it. When nothing is selected the field is
omitted everywhere and the run behaves exactly as before.

## Knobs

Per call:

```json
{ "prompt": "review this", "model": "muse-spark-1.3-contributor", "reasoningEffort": "xhigh" }
```

Or as an operator default, same keys either way (`plugins[].options` beats
`oc-dex.config.json`, which beats the built-in default of unset):

```json
{
  "reasoningEffort": "xhigh"
}
```

Precedence: call argument > operator default > unset. Unset means the `effort` key is
absent from the wire frame and the server default applies — no `null`, no empty string,
no silent fallback.

## Validation

Accepted values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Anything else —
`ultra`, `max`, `turbo`, `""`, `null` — fails at setup (operator default) or at call
time (per-call argument), before any process is spawned. The set is deliberately the
portable core, not the union of every client: Codex 0.169.0 advertises
`minimal`/`low`/`medium`/`high`/`xhigh`, the Responses API accepts
`none`/`minimal`/`low`/`medium`/`high`/`xhigh`, and `max`/`ultra` are
model-and-client-dependent extras that some providers reject at request time. A value
outside the set is a typo or an unadvertised level either way, so refusing it is the
fail-closed choice; widen it only with protocol evidence for the routed provider.

## Wire channel

Generated JSON Schema for the Codex 0.169.0 app-server protocol
(`codex app-server generate-json-schema`):

- `turn/start` accepts `effort`: "Override the reasoning effort for this turn and
  subsequent turns." This is the channel `oc_dex` uses. One run is one turn, so it
  covers fresh and resumed threads alike.
- `thread/start` and `thread/resume` have no effort field (their top-level keys are
  `approvalPolicy`, `model`, `modelProvider`, `cwd`, `sandbox`, etc.), so nothing
  effort-related is sent there. Verified: the frames on the wire carry no `effort`
  key on thread frames.

Deliberately not used: a process-global `-c model_reasoning_effort=…` flag (coarser
than the documented per-turn override) and `thread/start`'s generic `config` object
(second channel for the same value means two precedence rules to disagree).

## What the TUI actually draws

No code change was needed for visibility — the host already renders the full prompt
and the exact model for every run, verified statically against the OpenCode 2.3.0
bundle (`@opencode/cli-windows-x64@2.3.0/bin/opencode.exe`):

- Run line: `⚙ oc_dex [prompt=…, model=…, …]`. The `RT` input-summary formatter emits
  every string/number/boolean input value verbatim — no truncation, no ellipsis
  (contrast the output body, capped at 4096 chars, and list renderers capped at 4–6
  items). All `oc_dex` scalar inputs qualify, so `prompt` (full task),
  `model` (exact enum value), and `reasoningEffort` when set all appear.
- Title: `oc_dex` plus the full `JSON.stringify` of the input (fallback renderer
  `k`), so the prompt and model are in the row title too.
- Result: unknown tools use `view: {output: true, final: true}`, so the output body
  (which names model and, when set, effort) and the `oc_dex completed · <duration>`
  line are painted.

What is still not painted: custom-tool progress `metadata` (see `docs/progress.md`).
The effort therefore reaches the screen through the input summary, the title, the
permission gate metadata, and the output body — not through the progress stream.
The prompt is already shown in two of those places, so it is not duplicated into the
output body.
