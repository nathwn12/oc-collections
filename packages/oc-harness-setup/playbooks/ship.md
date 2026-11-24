Entry criteria: Enter when the work is verified and you are ready to land it.

### Ship

**You own what lands. Run the gate, then land the work, then read it back.**

1. Read the target version, the live branch, and the artifact destination.
2. Run the repository's full gate on the final tree.
3. Quote the gate's command, exit code, and key line.
4. Treat an inconclusive verdict as a failure, never as a pass.
5. Commit the slice with a conventional subject under 50 characters.
6. Fetch and rebase onto the trunk before you push.
7. Push with a fast-forward only.
8. Read the landing back and report the SHA you observed.
9. Keep publishing, tagging, and release work behind the owner's word.

**Reply:** what landed, the SHA you read back, the gate that proves it, and what still waits for approval.

## Exit - SHA receipt

Land small ordered commits, one green per commit. Report the command, exit, and key line for each check. Push and publish stay gated.
