# Repositories

## Lifecycle

- Every new repository starts **private**. It is created private, worked in private, and only flipped to **public** when genuinely ready.
- "Ready" means: a README that explains what it is and how to run it, a license, working install steps, no secrets in tree or history, and no dead links.
- **Public repositories are the priority set and are held to a higher standard**: clean history, tests that run, a README written for a stranger, and a correct license.
- Private repositories are personal work, experiments, or candidates waiting to go public. Lower bar, same care with secrets.

## Location

- Adopter repo root, defined once here: `<repo-root>/<repo>`. One repository, one checkout; a duplicate is a defect to consolidate.
- Third-party checkouts live under `<repo-root>/third-party/<repo>`, never beside owned work.

## Commit messages

- Conventional Commits always: `type(scope): description`.
- One line. Never a body. Never a footer, unless the repo requires it.
- Terse and casual, the way a working dev writes it — never a changelog entry.
- Never enumerate what changed; the diff already says that.

## Merge speed

- Docs-only, single-operator: `git diff --check` plus a link check on changed files, then commit; no PR and no code suite.
- Code: run the repo's fast check locally, push a branch, open the PR, and merge on green with squash.
- Fail fast: watch required checks once, read the failed log once.

## Install lines

- Public docs reference `@latest` for owned packages, never a pinned version — a pinned install line rots on the next publish.
- Exception: when compatibility is version-specific (a bridge, a runtime shim), pin, and say why in one line beside the command.
- Pin deliberately inside workflows, lockfiles and `package.json`. Docs are not lockfiles.
- A tag can trigger a release workflow; never tag as a side effect of a sync or merge.

## What an agent may do

- Prepare, edit, commit, branch, and prove locally.
- Outward verbs stay with the owner: the agent prepares, the owner pushes, publishes, releases, and merges. Never create a remote or change visibility.
- Never commit secrets, credentials, or env files, whatever the visibility.

## Deliver, not just commit

- A commit is not delivery: install the artifact on the local machine before calling work done, then say what was built and where it landed.
- A fix that exists only as a commit is unfinished.

## CI policy

- CI gates on fast checks only (lint, typecheck, unit tests, a build that finishes in minutes).
- Heavy bundles and release packaging run locally as delivery steps, never as merge gates.
