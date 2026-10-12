import { Database as LocalDatabase } from "bun:sqlite"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { audit } from "./audit"
import { convert, insertSql, verifySnapshot } from "./convert"
import { readSnapshot } from "./legacy"
const source = process.argv[2]
const destination = process.argv[3]
if (!source || !destination || !destination.endsWith(".sqlite"))
  throw new Error("Usage: import.ts <snapshot-directory> <new-local.sqlite> [--accept-review]")
await verifySnapshot(source)
const snapshot = await readSnapshot(source)
const findings = audit(snapshot)
if (
  findings.some(
    (f) =>
      f.severity === "block" ||
      (f.severity === "review" && !process.argv.includes("--accept-review")),
  )
)
  throw new Error("Snapshot audit requires review; nothing imported")
const converted = convert(snapshot)
const db = new LocalDatabase(destination, { create: true })
try {
  if (
    db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_source'").get()
  ) {
    const previous = db.query("SELECT exportedAt FROM migration_source").get() as {
      exportedAt: string
    }
    if (previous.exportedAt !== snapshot.exportedAt)
      throw new Error("Destination belongs to another snapshot")
  } else {
    if (db.query("SELECT name FROM sqlite_master WHERE type='table'").all().length)
      throw new Error("Destination must be empty")
    db.exec(
      await readFile(
        new URL("../../../../packages/db/migrations/0001_catalog.sql", import.meta.url),
        "utf8",
      ),
    )
    db.exec(
      await readFile(
        new URL("../../../../packages/db/migrations/0002_legacy.sql", import.meta.url),
        "utf8",
      ),
    )
    db.exec(
      await readFile(
        new URL("../../../../packages/db/migrations/0003_archive_selections.sql", import.meta.url),
        "utf8",
      ),
    )
    // Import order is ID-sorted in the source. Validate all relationships independently before
    // enabling runtime parent triggers, which otherwise require parent-before-child insertion.
    db.exec(
      "DROP TRIGGER entry_parent_insert; CREATE TABLE migration_source(exportedAt TEXT); CREATE TABLE migration_progress(name TEXT PRIMARY KEY,rows INTEGER NOT NULL);",
    )
    db.query("INSERT INTO migration_source VALUES(?)").run(snapshot.exportedAt)
  }
  let batches = 0
  for (const [table, rows] of Object.entries(converted.tables)) {
    const completed =
      (
        db.query("SELECT rows FROM migration_progress WHERE name=?").get(table) as {
          rows: number
        } | null
      )?.rows ?? 0
    for (let start = completed; start < rows.length; start += 500) {
      db.transaction(() => {
        for (const row of rows.slice(start, start + 500)) db.exec(insertSql(table, row))
        db.query(
          "INSERT INTO migration_progress(name,rows) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET rows=excluded.rows",
        ).run(table, Math.min(rows.length, start + 500))
      })()
      batches++
      if (Number(process.env.MIGRATION_STOP_AFTER_BATCHES) === batches)
        throw new Error("Simulated import interruption")
    }
  }
  db.exec(
    "CREATE TRIGGER IF NOT EXISTS entry_parent_insert BEFORE INSERT ON entries WHEN NEW.parentId IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM entries WHERE id=NEW.parentId AND kind='directory' AND deletedAt IS NULL AND deleting=0) THEN RAISE(ABORT,'invalid parent') END; END;",
  )
  const fk = db.query("PRAGMA foreign_key_check").all()
  if (fk.length) throw new Error("Foreign key reconciliation failed")
  await mkdir(join(source, "d1-manifests"), { recursive: true })
  for (const manifest of converted.manifests)
    await writeFile(
      join(source, "d1-manifests", manifest.key.split("/").at(-1) as string),
      manifest.body,
    )
  await writeFile(
    join(source, "d1-import-report.json"),
    JSON.stringify(
      {
        counts: Object.fromEntries(Object.entries(converted.tables).map(([t, r]) => [t, r.length])),
        manifests: converted.manifests.length,
        findings,
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({
      imported: Object.fromEntries(Object.entries(converted.tables).map(([t, r]) => [t, r.length])),
      manifests: converted.manifests.length,
    }),
  )
} finally {
  db.close()
}
