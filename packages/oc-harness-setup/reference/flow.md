# Flow — which seat fires, and the only roster

> A seat exists only where a seam does. A seam is exactly one of three kinds: **capability** (a reach no other seat holds), **permission** (a blast radius that must not sit in a routine seat), or **independence** (a verdict that must not come from the author). A seat that cannot name its seam in one clause does not exist; its work is a mode inside a seat that has one. New reach earns a seat. New craft never does.

## Seat routing — the only copy

| seat | seam | fires when | owns | not this (→ seat) | check |
|---|---|---|---|---|---|
| `code-agent` | permission (sole product-repo writer) | product-repo code, doc or packaging change | changed paths | harness change (→ `harness-agent`) | repo check exit cited |
| `verify-agent` | independence (verdict never from the author) | verdict or outward-text gate needed | findings + pass/fail | authorship of the work (→ owning seat) | cited output on pre-merge ref |
| `research-agent` | capability (sole open-web reach) | external fact needed | cited synthesis | local-only check (→ `host-agent`) | URL + date cited |
| `host-agent` | permission (sole host mutator) | host, process or file act | action log | product-repo edit (→ `code-agent`) | recovery path cited |
| `surface-agent` | independence (live surface from a seat that changed nothing) | live surface needed before diagnosis or close | service/repo table | diagnosis itself (→ owning seat) | commands cited |
| `harness-agent` | permission (sole harness writer) | harness structure change | files changed | product-repo change (→ `code-agent`) | line count + checks |
| `git-agent` | permission (sole outward git, non-release) | non-release commit or branch mechanics | commit/branch | release arc (→ `release-agent`) | preflight receipt cited |
| `secret-agent` | capability (sole secret reader) | secret or env value needed | redacted diff + key inventory | printing a value (→ never) | check cited, no value printed |
| `release-agent` | permission (irreversible outward) | release tag, publish or install | tag/publish receipt | non-release git (→ `git-agent`) | registry equals tag + scratch run |
| `memory-agent` | permission (sole lesson-record writer) | lesson or archive write needed | lessons + archive | verdict (→ `verify-agent`) | write cited with path |

`OUT:` names the artifact this seat produces, then the paths it may write.

A seat that writes no files declares `OUT: <artifact>; none (read-only)`; a verifier diffs the paths part against actual changed paths, and `none (read-only)` is conforming.

A brief goes to exactly one owning seat; the narrower seam wins on overlap; a seat finding work outside its seam stops and reports instead of absorbing it.

A trigger with no seat is a gap: report it, never improvise a seat mid-pass. A seat fired outside its trigger is a defect: name the trigger it should have had.

## When a new seat is earned
- A chokepoint — one reach is the queue — earns a seat: one trigger, reach, artifact, check.
- Slowness gets a cheaper model and a cleaner seam first; friction gets a mechanism first.
- Confusion means fix this table or name one writer; rot means `memory-agent` re-verifies; overlap means merge lanes. Never add a seat for these.

## Deferred
- `deferred` = a required seat's evidence was forbidden or postponed by the owner: record `UNVERIFIED (owner-deferred): <claim> — resume: <condition>`. It never blocks `done`; `parked` stays only on the owner's explicit order.
- Ceremony follows the autonomy rule in `AGENTS.md`: reversible work proceeds at full speed; only irreversible acts gate.

## Lane overlap
- Snapshot live lanes first (`GET /api/session/active`); classify from metadata only, never source or secrets. Disjoint scopes proceed immediately.
- Overlapping scopes: the older lane continues, the newer parks before it writes, and the disposition is recorded. No two writers on one artifact.
