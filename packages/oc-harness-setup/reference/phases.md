# Phases — the context move at a boundary
- Decide the move at a phase boundary, never mid-phase. A phase ends when the work stops being the same work.
- Mid-phase: continue, or split the leftover to a lane. Never compact mid-phase: it loses the thread.
- Four moves: **Continue** (stay, no switch), **Clear** (empty window, start from nothing), **Subagent** (its own window, a report comes back), **Compact** (compress, seed a fresh session).
- Ask in order, first yes wins:
  1. Can you continue? The next phase needs this one verbatim, or the window still fits — continue, it costs nothing and loses nothing.
  2. Is this context disposable? Then clear. Never clear context whose reason never comes back from a diff.
  3. Can it run unattended with no steering? Then a subagent.
  4. Otherwise compact, with an instruction naming the next phase.
- Every move other than Continue turns a primary source into a lossy secondary one. Pay that only when staying costs more than it saves.
- Nothing travels as a state file: what must survive is written into the next brief, or into a lesson or an ADR. Session state is retired.
- Treat compact as the default, never the first reach. At close, the single compaction is terminal by design.
- Accept taste: the same boundary can go two ways on two days.
