import { Database } from "bun:sqlite"
import { writeFile } from "node:fs/promises"
import { insertSql, type Row } from "./convert"
const source = process.argv[2]
const output = process.argv[3]
if (!source || !output)
  throw new Error("Usage: sql.ts <reconciled-local.sqlite> <new-d1-import.sql>")
const db = new Database(source, { readonly: true })
try {
  const tables = db
    .query(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all() as { name: string; sql: string }[]
  const parts: string[] = []
  for (const table of tables) {
    if (table.name.startsWith("migration_")) continue
    parts.push(`${table.sql};`)
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
  const objects = db
    .query(
      "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY rowid",
    )
    .all() as { sql: string }[]
  parts.push(...objects.map((o) => `${o.sql};`))
  parts.push(
    "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP);",
  )
  for (const name of ["0001_catalog.sql", "0002_legacy.sql", "0003_archive_selections.sql"])
    parts.push(`INSERT INTO d1_migrations(name) VALUES('${name}');`)
  parts.push("PRAGMA foreign_key_check;")
  await writeFile(output, parts.join("\n"), { mode: 0o600, flag: "wx" })
  console.log(JSON.stringify({ output, statements: parts.length }))
} finally {
  db.close()
}
