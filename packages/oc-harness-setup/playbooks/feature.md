Entry criteria: Enter on new behavior with an agreed design and a named proving check.

### Feature

**You own the design and the proof. Build the smallest change that satisfies both.**

1. Trace the files the new behavior will touch.
2. Name the data shape the feature needs before you write logic.
3. Write the proving check first, in words a beginner can follow.
4. Split the work into ordered steps you can verify one by one.
5. Build the first step and run its check.
6. Build each next step and run its check before moving on.
7. Run the full gate for the changed area and quote its exit.
8. Show the new behavior on the surface the user will use.
9. Rebase the work into small ordered commits.
10. Report each commit SHA in the receipt.

**Reply:** what you built, the choices you made and why, the check that proves it, and any open decision.

## Exit - SHA receipt

Land small ordered commits, one green per commit. Report the command, exit, and key line for each check. Push and publish stay gated.
