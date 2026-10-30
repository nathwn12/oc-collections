# Enforcement detail
Read when a hard deny, network reach, or an enforced-versus-instructed boundary matters.

- `policies` `tool.use` denies are hard: `*.env`, `*.env.*`, `*secrets*`, on read and on edit. They override ask and allow, and they are the only boundary in this pack a mechanism holds.
- One seat holds open-web reach: `research-agent`. A shell fetch by any other seat is denied; the single sanctioned exception is a brief that names the endpoint and the reason, run by `host-agent`.
- Outward verbs — push, publish, release, PR, merge, approve — are owner-gated. This pack grants none, so `git-agent` and `release-agent` prepare and prove, and the owner takes the final act.
- Code Mode (`execute`) carries its own `fetch`, so it is the one route that stays narrow: a seat holds it only when its agent file grants it.
- The rest is instructed, not enforced: brief-scoped path confinement, unprinted secret values, lane counts, and the no-redirection write rule. Drift there is caught by a check or a review, never by a claim.

<example>Good: `read:*.env` denied with Blocked by configuration policy. Good: `code-agent` denied `git push`. Bad: claiming a network boundary when shell is open.</example>
