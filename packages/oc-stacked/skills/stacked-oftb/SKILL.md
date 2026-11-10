---
name: Stacked OFTB
description: The out-of-the-box decision maker for a dead end - blocked, stopped, "no path", a rule that forbids the obvious move, a tool that refuses. Finds the route that reaches the same goal without crossing an owner gate, and says plainly when the block is real. Use on "we're blocked", "it won't let us", "find another way", "is there a workaround", before any ASK is written.
license: MIT
---

# Stacked OFTB

Out of the box. The seat you take when the straight line is closed.

It has one product: **a route to the same goal that nobody had to authorize.** Not a reinterpretation of the goal, not a permission quietly assumed, not a green you did not run. If no such route exists, its product is the sentence "the block is real" - delivered fast, with the receipt, so the owner can decide instead of waiting.

## First: which kind of rule is in the way

The whole skill is this table. Get it wrong and you become a machine for laundering violations.

| Kind | Examples | May you bend it? |
|---|---|---|
| **Owner gate** | irreversible, money over cap, a credential, publishing outward, a decision only the owner can own | **Never.** This is the wall. Route around it or stop. |
| **Doctrine default** | one commit per seam, one wave per session, install by script, a model's habit, "we always do it this way" | **Yes** - then record `RULING` with the cost if wrong. A default that cannot bend is a ritual. |
| **Physics** | a file lock, PATH order, a native binding, a version pin, a process already running | **No.** Not a rule at all. It is a fact, so you route around it instead of arguing. |

Most "blocks" are doctrine defaults that someone mistook for physics. Some are physics that someone mistook for a wall. Almost none are owner gates, and the ones that are must be named as such in the first line of the reply.

## The ladder

Take the highest rung that lands the goal, then stop climbing.

**1. Invert the order.** The sequence is usually the only thing blocking you.
Unplug, swap, handshake, replug. Test before install. Write the check before the fix. Nothing about the parts changed - only when they happen.

**2. Move the boundary.** Same work, smaller blast radius.
A scratch prefix instead of a global install. A throwaway process instead of the live one. A copy of the config instead of the config. A new session instead of this one. If the change is reversible *because* it is confined, confinement is the workaround.

**3. Split the variables.** A block is often two changes arguing.
Change the runtime *or* the version, never both, or a failure names neither. Two half-migrated waves make the failure ambiguous; one clean wave makes it a fact.

**4. Use the other door.** The product usually has more than one entry.
Git spec or registry. Config or files. Plugin or CLI. Skill or prompt. Documentation or source. When one door is shut, the question is "what else reaches the same place", not "how do I force this one".

**5. Borrow a witness.** When you cannot use the real surface, use something that exercises the same one.
A handshake in a throwaway process instead of the host's tools. The compiler on a two-line file instead of the project build. The pin read from the registry instead of remembered. A witness is admissible exactly when you say what it does not cover.

**6. Shrink the goal.** Land the part that is checkable today.
Park the rest as a named `PARKED` row with the reason. Half a migration with a green and a receipt beats a whole one that is "in progress" forever. Never shrink by silently dropping a requirement - the owner must be able to see what moved.

## The honesty floor

This skill exists to find the path, never to inflate the result.

- A workaround that produces a green you did not run is not a workaround. It is a lie with a plan attached.
- Craft lives in **sequencing and observation**. The moment it moves into **evidence**, it is out of bounds - and no amount of "but it works" reopens it.
- Every rung you take gets one line: `RULING · <route> · <what it bends> · <cost if wrong>`.
- Name what would make it illegal. If you cannot, you have not understood the rule you are bending.

## When the block is real

If all six rungs cross an owner gate, the answer is:

```text
The block is real. <gate> is the wall, and every route crosses it.
Route A: <what it needs>. Route B: <what it needs>.
Cheapest legitimate move: <one line>. Awaiting the owner.
```

Three lines, then stop. A block reported fast is worth more than a clever detour that quietly spends something the owner did not authorize. The skill's reputation depends on being trusted to stop, not only to find routes.

## Worked example, so the shape is not abstract

```text
Blocked:   an MCP server is live in this session, so its runtime cannot be swapped.
Kind:      physics (a running process), not an owner gate.
Rung 1:    the config is the plug. Change the entry, leave the process alive.
Rung 5:    prove the new runtime with an MCP handshake in a throwaway process,
           comparing tool counts against the live surface (25 / 7 / 229).
Rung 3:    pin the version to the npm one first, so runtime is the only variable.
Ruling:    swap-by-config, no restart, no downtime. Cost if wrong: the next
           session starts a server that fails its handshake - visible in one call,
           reverted by one line.
```

That is the whole skill: name the kind of rule, climb until the goal is reachable, prove it with the surface's own voice, write the ruling, and stop when the wall is the owner's.
