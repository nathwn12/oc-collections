# Research canon

A load-bearing claim comes from the source that owns it. These are the preferred sources; the precedence rule decides when they apply.

## Precedence

- Software, AI, LLM, harness, agent-loop, or graph work: the three preferred corpora below, in that order.
- Anything else: the primary source that owns the domain outranks all three — language reference, standard, vendor API, paper page, changelog.
- On conflict the domain owner wins. The preferred corpora are a default, not a cage.

## Tier 1 — preferred corpora

### Claude / Anthropic

- Claude Code docs — product docs root — https://code.claude.com/docs
- Claude API docs — platform docs root — https://platform.claude.com/docs/en/home
- Anthropic Engineering — long-form engineering posts — https://www.anthropic.com/engineering
- Anthropic Research — publication index — https://www.anthropic.com/research
- Claude Cookbooks — copyable API recipes — https://github.com/anthropics/claude-cookbooks
- Claude Code — agentic coding tool source — https://github.com/anthropics/claude-code
- Anthropic Courses — archived API and prompting courses — https://github.com/anthropics/courses

### Andrej Karpathy

- Profile — pins the teaching repositories — https://github.com/karpathy
- nanoGPT — trains and finetunes medium GPTs simply — https://github.com/karpathy/nanoGPT
- nanochat — full ChatGPT stack for about $100 — https://github.com/karpathy/nanochat
- llm.c — trains LLMs in raw C/CUDA — https://github.com/karpathy/llm.c
- llama2.c — Llama 2 inference in one C file — https://github.com/karpathy/llama2.c
- micrograd — tiny autograd engine teaching backprop — https://github.com/karpathy/micrograd
- Blog — long-form ML essays — https://karpathy.github.io/
- microgpt.py — 200-line dependency-free GPT trainer — https://gist.github.com/karpathy/8627fe009c40f57531cb18360106ce95

### Matt Pocock

- Profile — pins the skills repositories — https://github.com/mattpocock
- skills — composable engineering agent skills — https://github.com/mattpocock/skills
- ts-reset — fixes TypeScript built-in typings — https://github.com/mattpocock/ts-reset
- Total TypeScript — TypeScript course index — https://totaltypescript.com/
- AI Hero — AI engineering courses index — https://www.aihero.dev/

## Tier 2 — machinery

- OpenCode V2 docs — how this harness loads, permission-checks, and hooks — https://opencode.ai/v2/docs/
- Quote the installed `opencode --version` beside any line drawn from these docs.

## Tier 3 — everything else

Secondary by definition: blogs, summaries, forum answers, aggregators. Admitted only when Tiers 1 and 2 are silent, and labeled as secondary in the citation.

## General-domain examples

- Python 3 docs — language and library reference — https://docs.python.org/3/
- MDN JavaScript — web JavaScript reference — https://developer.mozilla.org/en-US/docs/Web/JavaScript
- RFC 9110 — HTTP semantics — https://www.rfc-editor.org/rfc/rfc9110
- arXiv 1706.03762 — the Transformer paper page — https://arxiv.org/abs/1706.03762

## Dissent

- Canon first, then argue with it: when Tier 1 covers a topic, name the strongest primary source that disagrees before concluding.
- A conclusion drawn from one voice is not a finding; it is a preference.
- If no dissent exists, say the search was run and name where you looked.
- Worked example: the starter's own write-single-lane rule rests on Cognition and Berkeley MAST, neither in Tier 1, while Anthropic covers the same topic from the other side. Without the dissent rule the design would have been confidently wrong. The audit is recorded in the harness build notes.

## The bar

- A load-bearing claim cites a primary source with an inline marker and a retrievable URL.
- Never invent a number, a quote, or a marker.
- A dead, moved, or paywalled source is reported as such, never cited as read.
- Two sources disagreeing is surfaced as a contradiction, not averaged.
- Local verification is the strongest runnable check, cited beside the claim it proves.
