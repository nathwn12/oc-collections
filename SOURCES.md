# Sources

oc-stacked is built from scratch. The code, the skills, the agents, the commands, and the `.stack/` format are original work. Ideas travel; text does not. This file exists so the lineage is honest: every project whose thinking shaped this one is named, with what we took, what we changed, and what we left behind. This is the only file in the repository permitted to name them.

## gstack — Garry Tan

URL: https://github.com/garrytan/gstack
License: MIT

- **What we learned.** Work that spans a day is a hierarchy, not a prompt: one controller cuts the work, workers own lanes, one authority merges. Readiness is a contract — a seam is landable only when a check is green at the head being landed. Notes are append-only, each lane reports in a fixed shape, and a digest with ages makes a stalled seam visible without asking anyone.
- **What we rewrote.** Three rungs instead of a roster: CEO, LEAD, EMPLOYEE, plus an AUDIT that wrote none of the work. State is five plain files under `.stack/` rather than a tool suite, and every rule is enforced by a tool that refuses — `brief` refuses a missing Out/Check/Owns, `ready` refuses an unnamed reason — instead of prose a model may skip under pressure.
- **What we did not take.** The role catalogue and the multi-tool surface. One loop, five verbs.

## andrej-karpathy-skills — multica-ai

URL: https://github.com/multica-ai/andrej-karpathy-skills
License: MIT (declared in the skill front matter; the repository carries no separate LICENSE file)

- **What we learned.** Four behavioural laws catch most of what makes agent output expensive: name the unknown before spending, make the smallest change, touch only your seam, prove it or say you did not. They derive from Andrej Karpathy's public observations (https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.
- **What we rewrote.** Guidance became gates. Law 3 is `scope`, which names every path outside the brief's `Owns`. Law 4 is `check` and `ready`, which bind green to a specific HEAD. `Unverified:` is a first-class report line that a gate can read, and the trap table is written in the voice of the agent about to make the mistake.
- **What we did not take.** The single-file distribution. A document that ships as context alone has no state, no refusal, and no memory after compaction.

## superpowers — Jesse Vincent

URL: https://github.com/obra/superpowers
License: MIT

- **What we learned.** A plugin, not a prompt pack: register skills natively, inject one small cached bootstrap into the first user message, stay dependency-free ESM, dispatch a fresh subagent per task, and prefer a recorded ruling to a stall. A stack that waits on a person buys nothing.
- **What we rewrote.** The bootstrap is under a screen and cached per session; the dispatch prompt carries a brief path and three fields, never history. Skills are ordinary `SKILL.md` files with front matter rather than generated or embedded content, so they can be read, diffed, and edited like code.
- **What we did not take.** The breadth of the skill library and the shell-script install path. Windows-first means no bash-only tooling at runtime.

## OpenCode documentation

URL: https://opencode.ai/docs/llms.txt
License: documentation, not code — no license asserted here for the prose

- **What we learned.** The plugin contract itself: skills declared as `SKILL.md` with front matter, tools described by a JSON-schema input and an execute function, agents and commands as files, session hooks for touching the first user message. Everything in this repository is built against that surface and nothing else.
- **What we rewrote.** We use the smallest subset that survives V2 (tested against 2.2.6) and keep a V1-compatible export so an older host loads without crashing. No hook does work that a tool could do on request.
- **What we did not take.** Nothing. This is the contract; deviating from it would only mean guessing.

## License posture

Our code is MIT and original. Ideas, methods, and workflow models are not copyrightable; the expression is. No source file from any project above was copied into this repository, in whole or in part, and none was transliterated line by line.

If a snippet ever is copied in, it will appear with its origin and license stated in this file and a header at the point of use. Adding a source here is not an admission of derivation; it is a record of reading.
