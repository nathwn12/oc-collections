---
name: evolve
description: "Use when the user asks to add a capability, write a skill, adopt an upstream feature, or improve the harness itself — decide the smallest extension, write it in house form, wire it 1:1, verify, and record it."
---

# evolve

Add one artifact at a time with the shipped CLI. The CLI fills a file from `templates/` and writes the result. Do not hand-write the artifact when the CLI can fill it.

## When to load

- "add a skill for this"
- "make the harness do X"
- "add a playbook for this task"
- "create a command or an agent for this"

## Command

```text
oc-harness-setup evolve <skill|command|agent|playbook> <id> [--title ...] [--description ...] [--body <file|->] [--dry-run] [--force]
```

`<kind>` selects the matching template. `<id>` names the artifact. Use `--body -` to read the body from standard input, or pass a file path to read from that file.

## Flags

| Flag | Effect |
| --- | --- |
| `--title` | Fills `{{title}}`. Defaults to the id. |
| `--description` | Fills `{{description}}`. Quote values that hold a colon. |
| `--body` | Fills `{{body}}` from a file, or from `-` for standard input. |
| `--dry-run` | Prints the filled artifact and its side effects. Writes nothing. |
| `--force` | Overwrites an existing artifact. Read the old file first. |

## What gets written

- `skill` writes `skills/<id>/SKILL.md`, its paired `commands/<id>.md`, and the `opencode.jsonc` skill allow entry.
- `command` writes `commands/<id>.md`.
- `agent` writes `agents/<id>.md` with `description` and `steps`.
- `playbook` writes `playbooks/<id>.md` and appends one row to the playbook match table.

## Rule

1. Pick the kind that matches the job. One extension at a time.
2. Run the command with `--dry-run` and read the filled artifact.
3. Check that no placeholder token survives and that each frontmatter scalar holding a colon is quoted.
4. Run the command without `--dry-run` to write it.
5. Run the doctor and the package gate. Quote command, exit, and key line.
6. Report every file written and its SHA.

## Never

- Never hand-write an artifact when the CLI can fill it.
- Never add a skill for a one-off task.
- Never leave a placeholder token in a shipped file.
- Never use `--force` on a file you have not read.
- Never widen the pack with a niche artifact; generalize or reject.
