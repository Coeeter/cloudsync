import { compareNames } from "../../src/server/services/ordering"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type LegacySnapshot, TABLE_FILES } from "./legacy"
export async function verifySnapshot(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    files: Record<string, { sha256: string }>
  }
  for (const file of Object.values(TABLE_FILES))
    if (
      manifest.files[file]?.sha256 !==
      createHash("sha256")
        .update(await readFile(join(directory, file)))
        .digest("hex")
    )
      throw new Error(`Checksum mismatch: ${file}`)
}
export const legacyNormalize = (name: string) => name.normalize("NFC").toLocaleLowerCase("en")
export type Row = Record<string, string | number | null>
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
function convertRow(row: Record<string, unknown>): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camel(key),
      typeof value === "boolean"
        ? Number(value)
        : key === "size" || key === "bytes"
          ? Number(value)
          : value,
    ]),
  ) as Row
}
export function convert(snapshot: LegacySnapshot) {
  const tables: Record<string, Row[]> = {
    entries: [],
    uploads: [],
    sessions: [],
    auth_pins: [],
    archives: [],
    cleanup: [],
    legacy_jobs: [],
    legacy_rate_limits: [],
    archive_selections: [],
  }
  const manifests: { key: string; body: string }[] = []
  for (const row of snapshot.entries) {
    const converted = convertRow(row as unknown as Record<string, unknown>)
    converted.deleting = 0
    if (!Number.isSafeInteger(converted.size)) throw new Error("Unsafe catalog integer")
    tables.entries?.push(converted)
  }
  const byId = new Map(snapshot.entries.map((e) => [e.id, e]))
  const pathOf = (id: string): string => {
    const parts: string[] = []
    let row = byId.get(id)
    while (row) {
      parts.push(row.name)
      row = row.parent_id ? byId.get(row.parent_id) : undefined
    }
    return parts.reverse().join("/")
  }
  const directories = snapshot.entries
    .filter((e) => e.kind === "directory")
    .map((e) => ({ id: e.id, path: pathOf(e.id) }))
  const byKey = new Map(
    snapshot.entries.filter((e) => e.object_key).map((e) => [e.object_key, e.id]),
  )
  for (const row of snapshot.uploads) {
    const converted = convertRow(row as unknown as Record<string, unknown>)
    converted.previewEntryId = null
    tables.uploads?.push(converted)
  }
  for (const row of snapshot.sessions)
    tables.sessions?.push(convertRow(row as unknown as Record<string, unknown>))
  for (const row of snapshot.pins)
    tables.auth_pins?.push(convertRow(row as unknown as Record<string, unknown>))
  for (const row of snapshot.archives) {
    const converted = convertRow(row as unknown as Record<string, unknown>)
    const id = row.id
    const legacyEntries = JSON.parse(row.manifest) as {
      path: string
      objectKey: string | null
      size: number
    }[]
    const entries = legacyEntries
      .map((e) => ({ path: e.path, objectKey: e.objectKey, size: Number(e.size) }))
      .sort((a, b) => compareNames(a.path, b.path))
    const fingerprint = createHash("sha256").update(JSON.stringify(entries)).digest("hex")
    const key = `system/zip-requests/${id}.json`
    manifests.push({ key, body: JSON.stringify({ version: 1, jobId: id, fingerprint, entries }) })
    // The immutable export retains interrupted job state; the new UI reports it explicitly.
    converted.status = ["completed", "failed"].includes(row.status) ? row.status : "failed"
    converted.error =
      converted.status === "failed" && row.status !== "failed"
        ? "Interrupted by the owner-paused migration; prepare the ZIP again"
        : row.error
    converted.fingerprint = fingerprint
    converted.manifest = key
    const selection = entries.map((e) => {
      if (e.objectKey) return byKey.get(e.objectKey) ?? `missing:${e.objectKey}`
      const path = e.path.replace(/\/$/, "")
      const matches = directories.filter((d) => d.path === path || d.path.endsWith(`/${path}`))
      return matches.length === 1 ? (matches[0]?.id as string) : `missing-path:${path}`
    })
    converted.selection = "[]"
    for (let page = 0; page * 500 < selection.length; page++)
      tables.archive_selections?.push({
        archiveId: id,
        page,
        ids: JSON.stringify(selection.slice(page * 500, page * 500 + 500)),
      })
    converted.leaseToken = null
    converted.leaseUntil = null
    converted.submittedAt = null
    converted.attempts = 0
    tables.archives?.push(converted)
  }
  for (const row of snapshot.jobs) {
    tables.legacy_jobs?.push({
      id: row.id,
      source: JSON.stringify(row),
      disposition: ["pending", "running"].includes(row.status)
        ? row.kind === "delete_objects"
          ? "cleanup"
          : "client-preview-or-explicit-archive-failure"
        : "historical",
    })
    if (row.kind === "delete_objects" && ["pending", "running"].includes(row.status)) {
      const payload = JSON.parse(row.payload) as { objectKeys?: string[]; keys?: string[] }
      const keys = payload.objectKeys ?? payload.keys
      if (!keys) throw new Error("Unknown deletion payload")
      tables.cleanup?.push({
        id: row.id,
        objectKeys: JSON.stringify(keys),
        createdAt: row.created_at,
      })
    }
  }
  for (const row of snapshot.rateLimits)
    tables.legacy_rate_limits?.push({
      id: `${row.key}:${row.window_started_at}`,
      source: JSON.stringify(row),
    })
  return { tables, manifests }
}
export function insertSql(table: string, row: Row) {
  const fields = Object.keys(row)
  const value = (v: string | number | null) =>
    v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`
  return `INSERT INTO ${table}(${fields.join(",")}) VALUES(${fields.map((f) => value(row[f] ?? null)).join(",")});`
}
