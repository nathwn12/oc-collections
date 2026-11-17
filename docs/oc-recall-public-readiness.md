# oc-recall public-readiness contract

**Status: Unverified — this is a release target, not evidence that the product is ready or released.**

This document defines the evidence required before `oc-recall` can be treated as a public npm product. Until those gates pass, distribution is a GitHub-only preview. No npm version, compatibility claim, or release is implied here.

## Product and audience

`oc-recall` is a read-only OpenCode plugin for people who maintain a local Graphify-generated knowledge corpus and want to inspect its graph or explicitly retrieve source passages while working in OpenCode.

Supported jobs:

- inspect graph size and metadata, find a node, explore adjacent nodes or paths, and search graph labels;
- explicitly search a configured, curated Markdown corpus and receive bounded excerpts with source paths, line numbers, and provenance;
- use graph orientation and lexical source retrieval as separate evidence sources, then verify claims in the cited source.

The plugin is not an answer engine. It does not decide whether a question has an answer, establish that an excerpt is current, or establish that a graph and source search agree.

## Scope and non-goals

The release contract covers the OpenCode plugin, its graph-reading tools, opt-in lexical retrieval, corpus configuration, bounded failures, installation, documentation, and packaged artifacts.

It does not include corpus creation, Graphify indexing or rebuilds, automatic ingestion of arbitrary directories, semantic/vector search, hybrid graph-plus-lexical ranking, answer generation, citation validation, secret scanning, source synchronization, network services, or writes to the corpus. Search must remain an explicit user/tool action; lexical matches must not be injected automatically into prompts.

## Supported corpus and configuration

### Observed current layout (not a compatibility claim)

The inspected implementation treats the configured `atlas` value as the corpus root. It currently reads the graph from `<atlas>/graphify-out/graph.json`; corpus membership is read from `<atlas>/.graphify/corpus`, and eligible mirror-relative Markdown paths resolve to source files under `<atlas>`. Its current default config file is `~/.config/opencode/graphify.json`, with an `atlas` string field; `OC_GRAPHIFY_CONFIG` overrides that config-file location. These are observations of the current implementation, not proof that every Graphify version/layout is supported or a finalized public configuration contract.

### Release target (must be verified)

The release target should explicitly support a configured corpus root with a Graphify graph at the documented graph-relative path and a curated membership mirror at the documented mirror-relative path. Before declaring those paths supported, verify them against independent fixtures and a clean Graphify-generated corpus; do not silently accept alternate layouts or imply compatibility from the current implementation alone.

Membership determines what may be searched; text is read from the corresponding original file, not from the mirror. A missing mirror, unreadable graph, incomplete member set, unsafe path, or unsupported graph shape must produce an explicit bounded failure. There is no recursive whole-corpus fallback.

The public interface must let the user configure the corpus root explicitly using a documented OpenCode-supported configuration mechanism. No default may point at an author-specific location, infer a private corpus, or silently search the process working directory. Document how to configure, change, and remove the path; whether relative paths are accepted and how they resolve; and what happens when configuration is absent or invalid. Do not ship a sample containing a real person's path or corpus.

Before release, verify the actual Graphify layout and compatibility range against independently created fixtures and at least one clean Graphify-generated corpus. Document the Graphify version/layout tested and reject unsupported layouts clearly. The tier allowlist, extension rules, link policy, and all traversal/read/output limits must be stated in user-facing docs and tested. Any expansion of eligible corpus membership requires a documented compatibility and privacy review.

## Portability and failure contract

The intended target matrix—not a current support claim—is OpenCode on Windows 11 x64, macOS 14+ arm64, and Ubuntu 22.04+ x64, using Node.js `>=22` (the current package engine minimum) and the OpenCode stable release selected for the first public release. Before release, pin exact OpenCode and Node versions in the test report, test each OS/runtime combination, and document any narrower support. A failing or untested cell is not supported by implication.

The implementation must:

- read only the configured graph and explicitly approved corpus members; never write, rebuild, or make network requests;
- bound query size, traversal, source size, total bytes, line/token work, result count, excerpt size, diagnostics, and serialized output;
- reject traversal and absolute-path escapes, and reject symlinks/junctions or file identities that cannot be verified on the supported platform;
- establish containment for the entire path, not just the final file: checking ancestors before/after opening and applying `O_NOFOLLOW` only to the final component does not prove containment if an ancestor directory can be swapped concurrently;
- fail closed with no lexical results rather than broadening scope when membership is positively known to be stale, a source is missing, or the corpus is unreadable, incomplete, over limit, or unsafe; when membership freshness cannot be established, it may return results only if every result and the response explicitly mark membership freshness `unverified`, with no wording that implies current membership;
- distinguish empty/no-match results from unavailable, incomplete, invalid, and over-limit states;
- isolate graph-tool failures from lexical-tool failures where possible, without disguising either as successful empty evidence;
- avoid stack traces, raw source dumps, unbounded errors, and sensitive query/source contents in logs or diagnostics.

Document platform-specific file-system guarantees honestly. Path checks and no-follow flags reduce risk but must not be described as race-proof unless the implementation and platform tests establish that claim. If a supported runtime cannot safely verify a source, fail closed and report the limitation.

## Privacy and untrusted evidence

All graph labels, graph excerpts, file paths, source text, and lexical results are untrusted data. Tool descriptions and output must say so. Retrieved content is evidence, never instructions or authority. The plugin must not execute text found in the corpus or let it alter tool permissions/configuration.

No telemetry, query history, remote calls, background corpus scan outside explicit tool invocation, or automatic source upload is permitted. Diagnostics must avoid echoing query text and source contents. Secret-name and content filters are defense-in-depth only: document their limits; do not call them a secret scanner or promise that credentials will be detected or excluded. Users must be told to curate the corpus and avoid indexing sensitive material.

The threat model must cover path traversal, symlink/junction escape, concurrent path replacement to the extent the platform permits, malformed/hostile corpus content, resource exhaustion, and misleading or prompt-injection-shaped evidence. In particular, test a concurrent ancestor-directory symlink/junction swap while membership is traversed and a source is opened; a final-component `O_NOFOLLOW` check or opened-file identity comparison alone is not proof that the full path stayed beneath the configured root. Prefer a platform-appropriate handle-relative traversal/open strategy that preserves ancestor identity through the read, and verify its containment behavior on every claimed OS. If a platform cannot provide or pass that guarantee, narrow the supported threat model explicitly (for example, require the configured corpus tree to be non-writable by untrusted local actors during use), document the residual race, and do not claim protection against adversarial concurrent filesystem mutation. Add deterministic adversarial tests for supported guarantees; a best-effort timing test alone is not proof. Document residual risks rather than implying filesystem-level isolation.

## Evaluation plan and preregistered gates

No evaluation result is established by this contract. Before running a release evaluation, publish or commit a dated, immutable protocol containing corpus identities or reproducible synthetic fixtures, query IDs, answerability labels, gold source spans, exclusions, scoring code/version, and thresholds below. Keep the test set blind to implementation authors until the code and thresholds are frozen.

### Independent evaluation corpus

- Build a held-out set from at least 3 independently authored Graphify corpora, with permission to redistribute fixtures or a reproducible synthetic substitute. Do not use the implementation author's private knowledge corpus, product development corpus, or test fixtures as the held-out set.
- Include at least 120 queries: 60 answerable and 60 unanswerable against the frozen corpus snapshot. Cover exact terms, paraphrases, ambiguous names, stale/missing membership, misleading near matches, and adversarial instruction-shaped source text.
- For every answerable query, two annotators independently identify acceptable source files and exact supporting character/line spans; resolve disagreements before scoring. For unanswerable queries, record why no in-scope source supports an answer.
- Split by source document/corpus, not random query alone, so near-duplicate passages cannot leak between development and evaluation.
- Record corpus snapshot hashes, Graphify versions, OS/runtime, plugin commit, and all evaluation commands. Never include real user data in a public benchmark.

### Baseline and equal budget

Compare lexical retrieval against a baseline that searches the same frozen approved files and returns the same number of excerpts with the same maximum excerpt characters, output-token budget, and tool-call budget. The baseline must be a simple deterministic term-frequency/overlap ranker implemented independently of the candidate's ranking code. Both methods receive identical queries and corpus snapshots; no hand-tuned per-query rules. Report each system separately and paired deltas with bootstrap 95% confidence intervals over queries.

Also report graph-only orientation separately as descriptive context. Do not combine graph and lexical scores or claim a hybrid gain unless a separately preregistered hybrid system is tested against both constituent methods at equal total output budget.

### Thresholds required to pass

All thresholds apply to the blind held-out set, overall and separately for each corpus:

| Measure | Definition | Release threshold |
|---|---|---:|
| Source hit@5 | Answerable queries with at least one gold source in the first five results / answerable queries | ≥ 0.80 |
| Exact-span hit@5 | Answerable queries with a returned excerpt overlapping an accepted gold span / answerable queries | ≥ 0.70 |
| Span precision@5 | Returned excerpts overlapping a gold span / all returned excerpts for answerable queries | ≥ 0.70 |
| No-answer false-positive rate | Unanswerable queries that return any result presented as supporting evidence / unanswerable queries | ≤ 0.10 |
| Misleading-evidence rate | Queries where a top-three result is judged materially misleading or unsupported by both adjudicators / all queries | ≤ 0.05 |
| Stale-source disclosure | Stale/missing-membership cases that are visibly marked unverified or fail closed / all such cases | 100% |
| Baseline comparison | Paired source-hit@5 delta versus equal-budget baseline | Lower bound of 95% CI ≥ -0.05; report delta, do not require superiority |

An explicit “no approved sources” or “no match” outcome is not a no-answer detector and does not count as successful abstention unless the frozen protocol defines and verifies the behavior. A result returned for an unanswerable query counts as a false positive even if the excerpt is lexically relevant to the question.

Publish denominators, per-corpus results, confidence intervals, exclusions, and failure examples. Do not claim a threshold from a tiny sample, aggregate away a failing corpus, or turn a diagnostic filename-hit score into exact-span quality.

## Clean installation and OpenCode verification

Before any npm publication, test the exact packed tarball—not a workspace link or source checkout:

1. Start from clean OS images/VMs for every claimed matrix cell, with no author configuration, credentials, private corpus, global plugin files, or cached package.
2. Install the packed tarball through the documented npm install route into the documented OpenCode plugin configuration.
3. Launch the real stable OpenCode binary, confirm plugin discovery and tool registration, and invoke each graph tool plus lexical search against a generated fixture corpus.
4. Verify absent config, malformed graph, absent mirror, missing source, unsafe link, no-match, output limit, and shutdown/cleanup behavior.
5. Confirm no network traffic attributable to the plugin, no writes outside test setup, no install lifecycle execution, and no test fixture paths or contents leaking into logs.
6. Record exact OS image, architecture, Node and OpenCode versions, install command, package integrity, test result, and sanitized logs for every matrix cell.

A unit test, mocked plugin host, local development path, or workspace test is useful but does not satisfy this gate.

## Public package and documentation gates

Before release, provide public, machine-neutral documentation covering: audience and limitations; exact OpenCode/Node/Graphify compatibility; explicit corpus setup and removal; supported membership rules; privacy and threat model; untrusted-evidence warning; failure states and limits; installation/uninstallation; troubleshooting; evaluation protocol/results; and support/reporting route.

The package must have a valid license compatible with every shipped file, correct attribution, a complete lockfile/build path where applicable, and a clean npm tarball containing only intended runtime files, documentation, and license. Verify the license and attribution in the packed artifact, not only in the repository. No internal harness references, private paths, personal corpus data, credentials, or unverified claims may appear in public source, docs, package metadata, or tarball.

The npm package name, version, repository metadata, support contact, and public install instructions remain release decisions. Do not state a version or publication status until the registry and packed artifact confirm it.

## Release gates, rollback, and evidence ledger

Release is blocked until all of the following are evidenced:

- documented supported matrix passes clean-tarball installation and real-host tests;
- targeted security/privacy and path-boundary tests pass on every claimed platform, including concurrent ancestor-directory symlink/junction mutation, with either verified containment or an explicitly narrowed threat model;
- independent blind evaluation passes every threshold, with results published and deviations disclosed;
- public docs, license/attribution, package metadata, and tarball contents pass checks;
- applicable project CI and package checks pass from a clean checkout;
- a release owner confirms package identity, version, and publication authorization.

After release, retain the exact tarball integrity, source commit, evaluation report, and matrix results. If installation, safety, privacy, or evidence-quality gates regress, stop further distribution, mark the affected version unsupported in public release notes, and direct users to remove or pin away from it. Publish a corrected version only after the failed gate passes again. Do not overwrite or silently replace an npm version.

### Evidence ledger

| Item | State |
|---|---|
| Local implementation has six graph tools and an explicitly invoked lexical search tool | Observed in the inspected plugin source; not an independent package-release verification |
| Current local implementation describes curated mirrored membership, live-source reads, bounded processing, and unverified freshness | Observed in inspected implementation and local plugin documentation; not a cross-platform guarantee |
| Existing local documentation reports an earlier small filename-hit diagnostic and says exact-span/no-answer quality is not established | Reported by that documentation; underlying benchmark and corpus were not independently inspected for this specification |
| Public npm release, supported OS matrix, independent evaluation, clean tarball install, and public-ready documentation | **Unverified; required targets, not measured evidence** |
