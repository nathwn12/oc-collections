# Releasing

Operational. Everything a release needs, in the order it is needed.

## Branch and tag

Branch names are two or three hyphenated words, no type prefix: `agent-routing`, `release-convention`.

A tag is `vX.Y.Z`, annotated, on the commit that was green, and `package.json` carries the same number. A tag and a manifest that disagree is a broken release, not a typo.

## Commit messages

Conventional Commits, exactly as upstream specifies:

```text
<type>(<scope>): <imperative summary>
```

Types: `feat fix refactor perf docs test chore build ci style revert`. Scope optional. Imperative mood — "add", not "added" or "adds". Fifty characters when possible, hard cap seventy-two, no trailing period.

**Subject only by default.** No body when the diff is self-explanatory. A body exists only for: the non-obvious why, a breaking change, a migration note, or an issue reference. Wrapped at 72, bullets `-`, references last (`Closes #42`).

Never: "this commit does", first person, a recital of changed files, AI attribution, or a restatement of the diff.

One seam per commit. A subject that needs "and" is two commits.

The check output belongs in the report and the pull request body, not the commit. Include it only when the check is the change.

A savepoint is a type, not a prefix: `chore: savepoint before the roster lands`, with an honest line in the body only if something is unverified and someone might rely on it.

## Adopt the upstream format

Adopt the upstream format when one exists — Conventional Commits for messages, semver for versions, the registry's own metadata schema, the host's own config schema, the project's own lint and test commands. Invent a house format only where upstream has none, and say in one line why.

## GitHub

One current release per repository, titled `oc-stacked vX.Y.Z`, body taken from `CHANGELOG.md` for that version.

Issues and pull requests carry evidence: the command, its output, the exit code. A report that says "fixed" is not a report.

Never force-push `main`. Never create, edit or bypass branch protection. A private repository stays private unless the owner says otherwise in writing.

## npm

This package is `"private": true`. Publishing is blocked by design, and unblocking it is an owner decision, not a convenience.

When it is unblocked:

- `prepublishOnly` runs `node scripts/check.mjs`; a release cannot publish on a red suite.
- Publish only from a clean tree on `main`.
- `npm publish --access public`.
- Verify: `npm view oc-stacked version` matches the tag, then one install from the registry in a scratch directory.
- Never unpublish. Deprecate instead: `npm deprecate oc-stacked@X.Y.Z "<why>"`.

## Prerelease

A trial ships under the `next` tag:

```text
npm publish --tag next
```

Promote to `latest` only after it has survived a week of real use with no red gate:

```text
npm dist-tag add oc-stacked@X.Y.Z latest
```

## Release is not a savepoint

Savepoints may be red and are never tagged. A tag names audited work only: the suite was green at that commit, and an auditor passed the pass it belongs to.

## The checklist

1. Suite green at the head being tagged.
2. `CHANGELOG.md` has an entry for the version.
3. `package.json` version equals the tag.
4. Index clean: `git status` prints nothing.
5. Tag, then push the tag: `git tag -a vX.Y.Z -m "..."`, `git push origin vX.Y.Z`.
6. Create the release from the changelog entry.
7. Verify: `npm view oc-stacked version` (when public) and one install from the registry.
8. State the version on `OWNER.md`'s release line.
