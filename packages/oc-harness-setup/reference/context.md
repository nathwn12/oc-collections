# Context detail
Read when the working set, delegation detail, mechanisms, or worked examples matter.

<example>Good: slice names one file plus its check. Good: verify cites command plus output. Bad: two artifacts in one slice.</example>

## Context budget
- Root ceiling is 200 lines, target 120. Quality outranks brevity: a decision belongs in the root, detail lives behind a pointer. Cut filler, never a rule.
- Skills stay <500 lines; detail sits behind pointers. Every reference targets 50 lines and hits 80 at worst.
- State is markdown; load the index first, detail on demand.
- Engineer the working set down; never fill the window.
<example>Good: a new rule goes behind a pointer. Good: a phase ends so context resets. Bad: pasting forty files into the trace.</example>

<example>Good: new network reach earns a seat. Good: a new doc type reuses `code-agent`. Bad: adding a seat for a craft.</example>

## Lanes
- One write lane per artifact; parallel reads freely.
- Twenty-four live lanes is the ceiling; past twenty-four, the rest queue. The seam decides whether a split is valid; the ceiling decides how many run.
- Two seats on one file is a collision, not a review. One writer per artifact, always; a second reader is free.
- Parallel writes run only across disjoint path sets, behind an integration point with a fresh `verify-agent`.
- Every brief carries objective, output format, tool/source guidance, task boundaries, a time budget, and the check that proves the end state.
- Return a summary plus `file:line`; raw reads stay in the child.
- Cost: a multi-agent run spends a multiple of a single chat — spend it on isolation and review, never on parallel writes to one file.
<example>Good: a forty-file sweep returns a summary. Good: two disjoint packages merge behind one `verify-agent`. Bad: two lanes editing one file.</example>

## Mechanisms
- Need automation? Prefer, in this order: a tool already installed on the machine → a package you add through the package manager → a small extension to OpenCode → a script you write and prove.
- A loose script is the last resort: allowed only when none of those fit, and it states in its header why they failed.
- Adding a mechanism is a harness change, not a task step: its own brief, its own proof, never a side effect of finishing something else.
- Whatever no mechanism can reach is an instruction, labelled as one — never dressed up as enforcement.
- Installing tooling is ingress: it pulls code in and sends nothing out, so the outward gate is unchanged. Name the package and the reason in the brief.
- Exception: a one-shot ceremony script under the temp session dir is a deliverable, not plumbing; it is deleted after the run, and it carries a header saying what it is for.

<example>Good: `pytest -q` cited passing. Good: a fresh `verify-agent` returns pass plus evidence. Bad: claiming green with no run.</example>
