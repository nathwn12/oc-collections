# Context detail
Moved verbatim from AGENTS.md root — read when the working set, delegation detail, mechanisms, or worked examples matter.

<example>Good: slice names one file plus its check. Good: verify cites command plus output. Bad: two artifacts in one slice.</example>

## Context budget
- Root ceiling is 200 lines, target 120. Quality outranks brevity: a decision belongs in the root, detail lives behind a pointer. Cut filler, never a rule.
- Skills stay <500 lines; detail sits behind pointers.
- State is markdown; load index first, detail on demand.
- Engineer the working set down; never fill the window.
<example>Good: new rule goes behind a pointer. Good: phase ends so context resets. Bad: pasting forty files into the trace.</example>

<example>Good: new network reach earns an agent. Good: new doc type reuses worker. Bad: adding a coder seat.</example>

- One write lane per artifact; parallel reads freely.
- Ten live lanes is the ceiling; past ten, queue. The seam decides whether a split is valid; the ceiling decides how many run.
- Two agents on one file is a collision, not a review. One writer per artifact, always; a second reader is free.
- Parallel writes only across disjoint file sets behind an integration point with a fresh verifier.
- Every brief carries objective, output format, tool/source guidance, task boundaries.
- Return a summary plus `file:line`; raw reads stay in the child.
- Cost: multi-agent runs ~15× single-chat tokens — spend them on isolation and review, never on parallel writes to one file.
<example>Good: forty-file sweep returns a summary. Good: two disjoint packages merge behind one verifier. Bad: two workers editing one file.</example>

## Mechanisms
- Need automation? Prefer, in this order: an installed plugin → an installed MCP → an existing CLI or npm tool → a small plugin you write → a small MCP you write.
- A loose script is the last resort: allowed only when none of those five fit, and it must state in its header why the five failed.
- Adding a mechanism is a harness change, not a task step: it gets its own brief and its own proof, never a side effect of finishing something else.
- Whatever no mechanism can reach is an instruction, and is labeled as one — never dressed up as enforcement.
- Installing tooling is ingress — it pulls code in and sends nothing out, so the outward gate is unchanged. Name the package and the reason in the brief.
- Harness and task plumbing may still not add a script: the ladder above holds, and a script stays the last resort.
- Exception: a one-shot ceremony script under the temp session dir is a deliverable, not plumbing; a 2FA click needs a visible terminal, so the script is allowed and is deleted after the run.
- A script the owner asks for is a deliverable, not infrastructure: it is the product, it is never wired into the harness, and it carries a header saying what it is for.
<example>Good: a missing capability becomes a plugin ref in config. Good: an existing CLI does the job and gets used. Bad: a one-off script that nothing proves and nobody owns.</example>

<example>Good: `pytest -q` cited passing. Good: fresh verifier returns pass plus evidence. Bad: claiming green with no run.</example>
