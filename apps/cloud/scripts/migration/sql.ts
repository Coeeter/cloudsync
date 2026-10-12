import { Database } from "bun:sqlite"
import { writeFile } from "node:fs/promises"
import { insertSql, type Row } from "./convert"
const source = process.argv[2]
const output = process.argv[3]
if (!source || !output)
  throw new Error("Usage: sql.ts <reconciled-local.sqlite> <d1-data-import.sql>")
const db = new Database(source, { readonly: true })
try {
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'migration_%' AND name NOT IN ('revision','assertions') ORDER BY rowid",
    )
    .all() as { name: string }[]
  const parentTrigger = db
    .query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='entry_parent_insert'")
    .get() as { sql: string } | null
  if (!parentTrigger) throw new Error("Source is missing entry_parent_insert")
  // The deploy workflow owns the schema, so this is data only. The CHECK on assertions aborts the
  // file before any insert if the destination already holds a catalog.
  const parts = [
    "INSERT INTO assertions(value) SELECT CASE WHEN EXISTS(SELECT 1 FROM entries) THEN 0 ELSE 1 END;",
    "DELETE FROM assertions;",
    // Trashed children of trashed folders are valid rows but fail the live-parent trigger.
    "DROP TRIGGER entry_parent_insert;",
  ]
  for (const table of tables) {
    const rows = db.query(`SELECT * FROM ${table.name}`).all() as Row[]
    if (table.name === "entries") {
      const byId = new Map(rows.map((r) => [r.id, r]))
      const memo = new Map<string, number>()
      const depth = (row: Row): number => {
        const id = String(row.id)
        const known = memo.get(id)
        if (known !== undefined) return known
        const parent = row.parentId ? byId.get(row.parentId) : undefined
        const value = parent ? depth(parent) + 1 : 0
        memo.set(id, value)
        return value
      }
      rows.sort((a, b) => depth(a) - depth(b) || String(a.id).localeCompare(String(b.id)))
    }
    for (const row of rows) parts.push(insertSql(table.name, row))
  }
  parts.push(`${parentTrigger.sql};`, "PRAGMA foreign_key_check;")
  await writeFile(output, parts.join("\n"), { mode: 0o600, flag: "wx" })
  console.log(JSON.stringify({ output, statements: parts.length }))
} finally {
  db.close()
}
