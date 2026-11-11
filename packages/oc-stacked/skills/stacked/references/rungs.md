# Stacked: which rung, which lens

Load this when deciding which rung a request needs, or which lens to add.

| Rung | Who | Owns | May never |
|---|---|---|---|
| **LEAD** | the session you are in, when work spans seams | deciding everything reversible: cutting seams, writing briefs, dispatching, reconciling, landing, the digest | take a seam it already dispatched, land on a worker's word alone, decide what the owner owns |
| **MORPH** | a fresh subagent per seam, on its card's model tier | one seam, one brief, one card, one check, one report | merge, push a shared branch, widen scope, dispatch anyone |
| **AUDIT** | a fresh context that wrote none of the code | the verdict on work it did not write | edit what it judges, accept the author's check as the verdict |

## Which rung are you on

- "Do X" where X is one edit → **morph** discipline inline. Do not build a stack for one seam.
- "Do X" where X spans files, decisions, or a day → **lead**. Read `stacked-lead`.
- "Just decide and do it" → the lead, with `stacked-pls` as its decision lens.
- "Is this actually right?" → **audit**, a context that wrote none of it. Read `stacked-audit`.
- "How should we build this?" → `stacked-plan` before any dispatch.
- "Do these at the same time" → `stacked-swarm`, and let the tool prove the seams are disjoint.
- "It's installed but not doing anything / align my host" → `stacked-wizard`: doctor, repair, init.
- "We're blocked", "it won't let us", "find another way" → `stacked-oftb`, before any `ASK` is written.

## The rest of the shelf

Load these when the moment matches; they are lenses, not gates.

| Skill | Load it when |
|---|---|
| `stacked-plan` | the design is not obvious, or the ask is a feature |
| `stacked-swarm` | more than one seam can run at once |
| `stacked-debug` | something throws, hangs, slows, or lies |
| `stacked-tdd` | behaviour changes and a test surface exists |
| `stacked-review` | you are asking for, receiving, or looping on a review |
| `stacked-ship` | the seam is ready to commit, close, or release |
| `stacked-deepen` | the complaint is about the code, not a feature |
