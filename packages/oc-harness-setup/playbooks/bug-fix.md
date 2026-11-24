Entry criteria: Enter on a failure you have reproduced on the surface where it happens.

### Bug fix

**You own the fix. Reproduce it, find the cause, verify the repair.**

1. Run the failing case yourself on the matching surface.
2. Save the exact command, exit code, and output as the before proof.
3. List every possible cause you can name.
4. Rule out each cause with a check you can run.
5. Confirm the surviving cause with runtime evidence.
6. Write the smallest change that removes that cause.
7. Re-run the before case and save the after proof.
8. Run the full gate for the changed area and quote its exit.
9. Stage the before proof and the fix as two ordered commits.
10. Report each commit SHA in the receipt.

**Reply:** what broke, the cause you confirmed, the change you made, and the before and after output pasted in full.

## Exit - SHA receipt

Land small ordered commits, one green per commit. Report the command, exit, and key line for each check. Push and publish stay gated.
