# Hygiene — leave no trail
- Send every scratch output to `%TEMP%\opencode\<session-id>\`; write nothing scratch into a repo.
- Never write a file through shell redirection or a heredoc; the `edit` action is the one write route, and the brief names the path.
- Treat as trash: agent-created untracked files, `test-results/`, `playwright-report/`, `.vite/`, traces, scratch screenshots, probe scripts, `.dev*.log`, and temp notes past their use.
- Treat as not trash: tracked files, owner-installed `node_modules`, shipped `dist/`, another session's state, and the owner's own files.
- Delete each trash file in the same turn it stops being needed; a scratch file outliving its turn is a defect.
- Stop the process writing a log before deleting that log.
- Name every deletion in the return, with paths. Name another agent's or session's artifacts before deleting any of them; never delete unnamed.
- Delete only what this session created. Older scratch belongs to the session that made it: name it in the return, never sweep it.
- Prove the pass clean: `git status --short` empty for every repo touched.
- Prove scratch clean: the temp session dir empty, or holding only named evidence for a pass still open.
- Report a duplicate clone, a retired prototype, or a stray branch; never delete one unasked.
- Treat cleanup as a delivery step, never as a courtesy.

## Trash sweep — runs at every close, no prompt needed
Delete, then report each class with its byte count:
1. `%TEMP%\opencode\<session>\*` — this pass's scratch, staged payloads, receipts, probe output, generated scripts.
2. Orphaned `%TEMP%\opencode\*` directories with no live session.
3. Lane-written logs, traces, dumps and throwaway artifacts under the session scratch root.
4. A stale global install or package cache — **only** where it would pin an old version of an owned package, so the next install proves new bytes.

Never delete: repos, checkouts, `state\`, `reference\archive\`, or any owner file. A path outside classes 1–4 is reported, not removed.

## Local checkout at close
- End on `main`, clean, equal to `origin/main`: `git rev-parse --abbrev-ref HEAD`, `git status --short`, then `git fetch` and `git rev-list --left-right --count main...origin/main` reading `0  0`.
- Delete local branches already merged into `origin/main` (`git branch --merged origin/main`); keep unmerged ones and name them.
- A branch earns its place only while in development, on hold, or parked with a named resume condition. Prune the settled one with proof: `git tag archive/<branch>-<sha> <sha>`, then `git branch -D <branch>` — cite the sha and the tag that holds it.
- Uncommitted work, or a commit that exists nowhere else: report it and leave the clone alone — never force except `--force-with-lease` against a freshly read sha.
- `git status` clean upstream conceals a dirty working copy: check the clone, not the remote.

## Close receipt — branches
Three lines, and `none` rather than an omission: **kept** (each branch with its resume condition), **pruned** (each branch with the sha and the ref that preserves it), **untouched** (each repo the pass deliberately stayed out of).
