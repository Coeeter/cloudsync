import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readSnapshot } from "./legacy"
import { verifySnapshot } from "./convert"
const directory = process.argv[2]
const destination = process.argv[3]
if (!directory || !destination)
  throw new Error("Usage: reconcile.ts <snapshot-directory> <local.sqlite>")
await verifySnapshot(directory)
const source = await readSnapshot(directory)
const db = new Database(destination, { readonly: true })
const differences: { table: string; id: string; field: string }[] = []
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
function compare(table: string, records: Record<string, unknown>[], ignored: string[] = []) {
  const actual = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
  const byId = new Map(actual.map((r) => [r.id, r]))
  for (const expected of records) {
    const row = byId.get(expected.id)
    if (!row) {
      differences.push({ table, id: String(expected.id), field: "missing" })
      continue
    }
    for (const [key, value] of Object.entries(expected)) {
      if (ignored.includes(key)) continue
      const normalized =
        typeof value === "boolean"
          ? Number(value)
          : key === "size" || key === "bytes"
            ? Number(value)
            : value
      if (row[camel(key)] !== normalized)
        differences.push({ table, id: String(expected.id), field: key })
    }
  }
  if (actual.length !== records.length) differences.push({ table, id: "count", field: "count" })
}
try {
  compare("entries", source.entries as unknown as Record<string, unknown>[])
  compare("uploads", source.uploads as unknown as Record<string, unknown>[])
  compare("sessions", source.sessions as unknown as Record<string, unknown>[])
  compare("auth_pins", source.pins as unknown as Record<string, unknown>[])
  compare("archives", source.archives as unknown as Record<string, unknown>[], [
    "fingerprint",
    "manifest",
    "status",
    "error",
  ])
  const collator = new Intl.Collator("und", { numeric: true, sensitivity: "accent" })
  for (const archive of source.archives) {
    const record = db.query("SELECT * FROM archives WHERE id=?").get(archive.id) as Record<
      string,
      unknown
    >
    const entries = (
      JSON.parse(archive.manifest) as { path: string; objectKey: string | null; size: number }[]
    )
      .map((e) => ({ path: e.path, objectKey: e.objectKey, size: Number(e.size) }))
      .sort(
        (a, b) =>
          collator.compare(a.path, b.path) ||
          Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
      )
    const expectedFingerprint = createHash("sha256").update(JSON.stringify(entries)).digest("hex")
    const expectedStatus = ["completed", "failed"].includes(archive.status)
      ? archive.status
      : "failed"
    const expectedError =
      expectedStatus === "failed" && archive.status !== "failed"
        ? "Interrupted by the owner-paused migration; prepare the ZIP again"
        : archive.error
    if (
      record.fingerprint !== expectedFingerprint ||
      record.status !== expectedStatus ||
      record.error !== expectedError ||
      record.manifest !== `system/zip-requests/${archive.id}.json`
    )
      differences.push({ table: "archives", id: archive.id, field: "disposition" })
    const manifest = JSON.parse(
      await readFile(join(directory, "d1-manifests", `${archive.id}.json`), "utf8"),
    ) as { entries: unknown; fingerprint: string }
    if (
      JSON.stringify(manifest.entries) !== JSON.stringify(entries) ||
      manifest.fingerprint !== expectedFingerprint
    )
      differences.push({ table: "archives", id: archive.id, field: "manifest" })
  }
  for (const job of source.jobs) {
    const row = db.query("SELECT source FROM legacy_jobs WHERE id=?").get(job.id) as {
      source: string
    } | null
    if (!row || row.source !== JSON.stringify(job))
      differences.push({ table: "jobs", id: job.id, field: "source" })
  }
  for (const row of source.rateLimits) {
    const actual = db
      .query("SELECT source FROM legacy_rate_limits WHERE id=?")
      .get(`${row.key}:${row.window_started_at}`) as { source: string } | null
    if (actual?.source !== JSON.stringify(row))
      differences.push({ table: "rate_limits", id: row.key, field: "source" })
  }
  const foreignKeys = db.query("PRAGMA foreign_key_check").all()
  const report = {
    equal: differences.length === 0 && foreignKeys.length === 0,
    differences,
    foreignKeys,
    entries: source.entries.length,
    microsecondTimestamps: source.entries.filter((e) => /\.\d{6}Z$/.test(e.created_at)).length,
  }
  await writeFile(join(directory, "d1-reconciliation.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  if (!report.equal) process.exitCode = 1
} finally {
  db.close()
}
