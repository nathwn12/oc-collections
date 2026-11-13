# oc-fallback

Lets an agent seat step down its own model ladder when its model fails: one `switch_model` tool, one config file, and an automatic failover that ships off until a real provider failure proves it.

## Not published

This package is `private: true` and is loaded from this repository, by path. It is not on npm, it is not in the release allowlist (`scripts/release-target.mjs`), and nothing installs it but a `plugins` entry:

```json
{ "plugins": ["Q:\\PROJECTS\\PERSONAL\\oc-collections\\packages\\oc-fallback"] }
```

Restart OpenCode. `oc-fallback` then registers the tool and the hook when a session starts.

## Configuration

Everything is one file: `~/.config/opencode/oc-fallback.json`, or the file named by `OC_FALLBACK_CONFIG`. `OC_FALLBACK=off` disables the plugin without touching either.

```json
{
  "enabled": true,
  "provider": "opencode-go",
  "ladders": { "file": "Q:\\PROJECTS\\PERSONAL\\oc-superpowers\\harness.json", "key": "fallbacks" },
  "rules": {
    "autoFailover": false,
    "excludeFree": true,
    "requirePublishedBenchmark": true,
    "maxInputUsd": 0.15,
    "maxOutputUsd": 0.6,
    "rungMayNotCostMoreThanPinned": false
  },
  "logPath": "C:\\Users\\you\\.local\\share\\opencode\\log\\oc-fallback.log",
  "sitemapUrl": "https://opencode.ai/data/sitemap.xml",
  "benchmarkTtlMs": 21600000
}
```

Every key is optional; each one falls back to the default shown above. A file that is missing or does not parse is not an error: the built-in defaults stand in and one line in the log says the file was not read.

| Key | What it decides |
| --- | --- |
| `enabled` | `false` registers nothing at all. |
| `provider` | The one provider this package will ever serve. A session on any other provider is left alone, and a rung naming another provider is refused. |
| `ladders` | The ladders, inline or by pointer — see below. |
| `rules.autoFailover` | Whether a recorded provider failure moves the next request one rung down by itself. **Off by default:** the automatic path is only unit-proven against a fake host, so it stays idle until a real provider failure has been observed moving a session. The tool works with it off. |
| `rules.excludeFree` | Refuse any rung whose id says it is free. |
| `rules.requirePublishedBenchmark` | Refuse any rung that publishes no benchmark on the public site. |
| `rules.maxInputUsd`, `rules.maxOutputUsd` | Per-1M-token ceilings from the live catalog's own `cost`. `null` turns that ceiling off. |
| `rules.rungMayNotCostMoreThanPinned` | Refuse a rung dearer than rung 0 of its own ladder. **Off by default:** a ladder ordered by capability rather than price will legitimately step up in cost, and the `maxOutputUsd` ceiling already bounds it. Turn it on to make cost monotonic instead. |
| `logPath` | Where the event lines go. |
| `sitemapUrl`, `benchmarkTtlMs` | Where the published-benchmark answer comes from, and how long it is trusted. |

### Ladders, inline or by pointer

Inline, the ladders live in this file:

```json
{ "ladders": { "implementer": ["opencode-go/deepseek-v4.1-flash", "opencode-go/muse-spark-1.3-contributor"] } }
```

By pointer, they live somewhere else and this package only reads them:

```json
{ "ladders": { "file": "Q:\\PROJECTS\\PERSONAL\\oc-superpowers\\harness.json", "key": "fallbacks" } }
```

`key` defaults to `fallbacks`, and the value there is `{ "<agent>": ["provider/model", ...] }`, best first. The pointer form exists so one file stays the only record of which model serves which seat: the file is read at setup, never copied, never merged, never written back.

Rung 0 is the seat's pinned model. A seat with no pin inherits the session model, which the owner selects in the TUI; that seat is TUI-agnostic, so it carries **no ladder** and `switch_model` answers `no-ladder` for it. That is deliberate, not a gap.

## What you get

| | |
| --- | --- |
| `switch_model` | `list: true` prints the ladder and the current rung and changes nothing. No arguments moves one rung down. `rung: 2` jumps to an absolute rung. `model: "provider/model"` names one that is already on the ladder. |
| Automatic failover | When the host records a provider failure for a session, the next request for that session is served one rung further down, on the same provider. A title request never spends a rung. Off unless `rules.autoFailover` is on. |

Every refusal is a typed JSON object — `at-floor`, `not-on-ladder`, `not-available`, `cross-provider`, `caller-unknown`, `unknown-agent`, `no-ladder`, `free-model`, `no-benchmark`, `over-price`, `over-pinned` — never a throw. `over-price` and `over-pinned` also name the rule that refused.

## The rules a rung must pass

A rung is admitted only when all of these hold. The tool and the automatic path run the same chain, so nothing can be served that `switch_model` would refuse.

1. Its provider is this config's provider — the same refusal OpenCode's own model resolution gives a foreign model.
2. Its id does not say `-free`, while `rules.excludeFree` is on.
3. It exists in the live catalog the host reports.
4. Its page on the public site lists at least one benchmark, while `rules.requirePublishedBenchmark` is on. The site indexes every model page in `sitemap.xml`; the id's slug (dots become dashes) finds the page, and an empty `model.benchmarks` array is the refusal.
5. Its catalog price is inside both ceilings. A model with no `cost` entry is unpriced, so the ceilings are skipped for it and the log says so — a price is never guessed.
6. It costs no more than its ladder's rung 0, while `rules.rungMayNotCostMoreThanPinned` is on — off by default, so a capability-ordered ladder may step up in cost inside the ceiling.

Two answers fail open, because neither is a verdict about a model: a benchmark site that cannot be reached, and a model whose page is not in the sitemap. Both are logged as a skip and the rung is allowed.

## The log

One tab-separated line per event — timestamp, session, agent, from, to, reason — in `logPath` and on the console. An error contributes its type and status and never its message, because a provider's message can carry the request's credential.

## Requirements

OpenCode V2, with Node 22 or newer.
