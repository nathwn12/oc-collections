# Models and cost

No model pins ship. Every seat inherits the session model until the user binds one.

## Tiers

- **Bulk tier (cheap).** Drafting, workers, research, audits, iteration. Fan out freely; never trade speed for token anxiety here.
- **Verdict tier (costly).** Judgement only: verdicts, reviews, design audits, anything where being wrong is expensive. Never use it for bulk reading or drafting.

## How to bind

- Bind per seat in the user `agents` map in `opencode.jsonc`, or with a `model:` line in an agent's frontmatter.
- Use only an id that resolves in the catalog below; an unresolvable id fails the doctor check.
- Keep the verdict seat on the costly tier and everything else on the cheap tier unless a brief says otherwise.

## Catalog

- The doctor parses one bullet per model, exactly ``- `<provider>/<model-id>` — <tier>``.
- Alternatively, a `Model (<provider>/<id>)` line plus `| n | `<id>` |` rows resolves the same way.
- Example (fenced block is illustrative only; angle-bracket placeholders are not parsed as catalog entries):

```
- `<provider>/<cheap-model>` — bulk tier
- `<provider>/<verdict-model>` — verdict tier
```

## Rule

- Spend the costly tier on the verdict, and the cheap tier on everything that feeds it.
