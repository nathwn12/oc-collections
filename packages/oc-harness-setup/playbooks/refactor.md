Entry criteria: Enter when the structure must change while the behavior stays the same.

### Refactor

**You own the contract. Change the structure. Hold the behavior steady.**

1. Write down the behavior you promise to keep.
2. Capture that behavior in a test, a snapshot, or a recorded output.
3. Run the capture before any structural edit and save it as the pin.
4. Name the missing shape in one sentence.
5. Delete dead code and one-caller wrappers before adding anything.
6. Move the structure in one small step at a time.
7. Re-run the pin after every step and stop on the first failure.
8. Compare the old and new outputs on a real run.
9. Revert any step that does not make the code easier to read.
10. Rebase the work into small ordered commits and report each SHA.

**Reply:** the structure that changed, the pin you held, the equivalence proof, what got reverted, and confirmation that no behavior was added.

## Exit - SHA receipt

Land small ordered commits, one green per commit. Report the command, exit, and key line for each check. Push and publish stay gated.
