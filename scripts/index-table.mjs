#!/usr/bin/env node
// index-table.mjs - the README index's grammar, read once.
//
// scripts/check-index.ps1 parses the same table in PowerShell. A second grammar
// would drift from the first: a cell this file calls a pin and that script calls
// prose is how a gate stays green while CI goes red. The rules below are its
// rules, restated here because a Node script cannot call a pwsh function:
//
//   - a row is a line whose first character is `|`; its cells are the trimmed
//     halves between pipes (check-index.ps1, the row loop);
//   - cells[0] is the Package label, cells[1] the Kind, cells[2] the Version
//     cell, and a pin is the first backticked token in that cell;
//   - a scoped package's label is its unscoped half (Get-PackageLabel);
//   - the inventory is the root manifest plus every packages/* and archive/*
//     manifest that has one (Get-WorkspaceInventory).
//
// scripts/check-version-cell.test.mjs asserts this file and check-index.ps1
// report the same failure for the same stale cell.
import fs from "node:fs"
import path from "node:path"

export const ROOT = path.resolve(import.meta.dirname, "..")

/** @scope/name -> name; anything else is its own label. */
export function packageLabel(name) {
  const match = /^@[^/]+\/(.+)$/.exec(String(name))
  return match ? match[1] : String(name)
}

/**
 * The table's rows and the file's own lines, so a caller can rewrite one cell
 * without touching the rest of the file, and can rejoin with the same EOL.
 */
export function readReadme(readmePath) {
  const text = fs.readFileSync(readmePath, "utf8")
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(/\r?\n/)
  const rows = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.startsWith("|")) continue
    const cells = line
      .trim()
      .replace(/^\|+/, "")
      .replace(/\|+$/, "")
      .split("|")
    if (cells.length < 2) continue
    const name = cells[0].trim()
    if (name === "Repo" || name === "Package" || /^[-: ]+$/.test(name)) continue
    rows.push({ name, line, index, cells })
  }
  return { text, eol, lines, rows }
}

/** The Version cell's text, or "" when the row is too short to have one. */
export function cellVersion(row) {
  return row.cells.length >= 3 ? row.cells[2].trim() : ""
}

/** The first backticked token in a cell: the table's claim about published bytes. */
export function cellPin(cell) {
  const match = /`([^`]+)`/.exec(cell)
  return match ? match[1] : null
}

/**
 * Every package this tree has a manifest for, keyed by table label. A label is
 * unique in practice (the table and check-index.ps1 both assume it), so the
 * last manifest read wins rather than silently keeping two.
 */
export function readInventory(root = ROOT) {
  const entries = new Map()
  const add = (manifestPath, dir) => {
    const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (typeof pkg.name !== "string" || pkg.name.length === 0) return
    entries.set(packageLabel(pkg.name), { label: packageLabel(pkg.name), name: pkg.name, version: pkg.version, dir })
  }
  add(path.join(root, "package.json"), root)
  for (const base of ["packages", "archive"]) {
    const dir = path.join(root, base)
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = path.join(dir, entry.name, "package.json")
      if (fs.existsSync(manifest)) add(manifest, path.join(dir, entry.name))
    }
  }
  return entries
}
