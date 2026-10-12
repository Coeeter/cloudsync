import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { legacyNormalize, verifySnapshot } from "./convert"
import { type LegacyEntry, type LegacySnapshot, readSnapshot } from "./legacy"

export type Severity = "block" | "review" | "info"

export interface Finding {
  readonly check: string
  readonly severity: Severity
  readonly count: number
  readonly sample: ReadonlyArray<string>
}

/**
 * Snapshot anomaly audit run before import. `block` findings stop cutover; `review` findings need an
 * explicit owner decision; `info` findings describe expected legacy states the conversion handles.
 * Nothing is repaired here.
 */
export function audit(snapshot: LegacySnapshot): Array<Finding> {
  const found = new Map<string, { severity: Severity; ids: Array<string> }>()
  const add = (check: string, severity: Severity, id: string) => {
    const finding = found.get(check) ?? { severity, ids: [] }
    finding.ids.push(id)
    found.set(check, finding)
  }
  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]))

  const ancestry = new Map<string, Array<LegacyEntry> | null>()
  const chain = (entry: LegacyEntry): Array<LegacyEntry> | null => {
    if (ancestry.has(entry.id)) return ancestry.get(entry.id) ?? null
    const seen = new Set<string>()
    const result: Array<LegacyEntry> = []
    let current: LegacyEntry | undefined = entry
    while (current) {
      if (seen.has(current.id)) {
        ancestry.set(entry.id, null)
        return null
      }
      seen.add(current.id)
      result.push(current)
      if (!current.parent_id) break
      current = byId.get(current.parent_id)
      if (!current) {
        ancestry.set(entry.id, null)
        return null
      }
    }
    ancestry.set(entry.id, result)
    return result
  }

  const activeNames = new Map<string, string>()
  let submillisecond = 0
  for (const entry of snapshot.entries) {
    if (entry.parent_id && !byId.has(entry.parent_id)) add("dangling parent", "block", entry.id)
    const path = chain(entry)
    if (!path && (!entry.parent_id || byId.has(entry.parent_id)))
      add("parent cycle", "block", entry.id)
    if (entry.kind !== "directory" && entry.kind !== "file") add("unknown kind", "block", entry.id)
    if (
      !entry.name ||
      entry.name === "." ||
      entry.name === ".." ||
      entry.name.includes("/") ||
      entry.name.includes("\0")
    ) {
      add("invalid name", "block", entry.id)
    }
    if (entry.normalized_name !== legacyNormalize(entry.name))
      add("normalization mismatch", "block", entry.id)
    if (entry.kind === "file" && !entry.object_key)
      add("file missing original key", "block", entry.id)
    if (entry.kind === "directory" && entry.object_key)
      add("directory with object key", "review", entry.id)
    if (!Number.isSafeInteger(Number(entry.size)) || Number(entry.size) < 0)
      add("unsafe size", "block", entry.id)
    if ([entry.created_at, entry.updated_at].some((value) => !value.endsWith("000Z")))
      submillisecond += 1

    if (entry.deleted_at === null) {
      if (entry.trash_root_id !== null) add("active entry with trash root", "block", entry.id)
      if (path?.slice(1).some((ancestor) => ancestor.deleted_at !== null)) {
        add("active entry beneath deleted ancestor", "block", entry.id)
      }
      const key = `${entry.parent_id ?? ""}\u0000${entry.normalized_name}`
      if (activeNames.has(key)) add("active sibling name collision", "block", entry.id)
      activeNames.set(key, entry.id)
    } else {
      const root = entry.trash_root_id ? byId.get(entry.trash_root_id) : undefined
      if (!entry.trash_root_id) add("deleted entry without trash root", "block", entry.id)
      else if (!root) add("dangling trash root", "block", entry.id)
      else if (root.deleted_at === null || root.trash_root_id !== root.id) {
        add("trash root is not a deleted root", "block", entry.id)
      } else if (entry.id !== root.id && !path?.some((ancestor) => ancestor.id === root.id)) {
        add("trash root is not an ancestor", "block", entry.id)
      }
      if (entry.id === entry.trash_root_id) {
        if (entry.original_parent_id && !byId.has(entry.original_parent_id)) {
          add("dangling original parent", "review", entry.id)
        }
        if (entry.original_parent_id !== entry.parent_id)
          add("original parent differs from parent", "review", entry.id)
        if (entry.parent_id && byId.get(entry.parent_id)?.deleted_at) {
          add("trash root beneath deleted parent", "block", entry.id)
        }
      } else if (entry.original_parent_id) {
        add("absorbed earlier trash root (restores with its enclosing root)", "info", entry.id)
      }
      if (root && entry.deleted_at !== root.deleted_at)
        add("deleted time differs from its root", "info", entry.id)
    }
  }
  if (submillisecond > 0) {
    found.set("microsecond timestamps (preserved as text)", {
      severity: "info",
      ids: Array.from({ length: submillisecond }, () => ""),
    })
  }

  const entryIds = new Set(byId.keys())
  for (const upload of snapshot.uploads) {
    if (upload.status === "finalized" && upload.entry_id && !entryIds.has(upload.entry_id)) {
      add("finalized upload whose entry was later deleted", "info", upload.id)
    }
    if (upload.status === "finalized" && !upload.entry_id)
      add("finalized upload without entry", "block", upload.id)
    if (upload.status !== "pending" && upload.status !== "finalized") {
      add(`upload status ${upload.status}`, "review", upload.id)
    }
    if (upload.status === "pending" && upload.expires_at > snapshot.exportedAt) {
      add("unexpired pending upload (still finalizable)", "info", upload.id)
    }
  }

  const terminalPreviewFailures = new Set<string>()
  for (const job of snapshot.jobs) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(job.payload) as Record<string, unknown>
    } catch {
      add("unparseable job payload", "block", job.id)
      continue
    }
    if (!["preview", "archive", "delete_objects"].includes(job.kind))
      add("unknown job kind", "block", job.id)
    if (job.kind === "preview" && !entryIds.has(String(payload.entryId))) {
      add("preview job for deleted entry", "info", job.id)
    }
    if (job.kind === "preview" && job.status === "completed" && job.error) {
      terminalPreviewFailures.add(String(payload.entryId))
    }
    if (job.status === "running")
      add("running job at export (worker not quiesced?)", "review", job.id)
    if (job.status === "pending" || job.status === "failed")
      add(`actionable ${job.kind} job`, "info", job.id)
  }
  for (const entryId of terminalPreviewFailures) {
    const entry = byId.get(entryId)
    if (entry && !entry.preview_error && !(entry.thumbnail_key && entry.preview_key)) {
      add("failed preview job without visible failure marker", "review", entryId)
    }
  }

  const archiveIds = new Set(snapshot.archives.map((archive) => archive.id))
  for (const archive of snapshot.archives) {
    try {
      const manifest = JSON.parse(archive.manifest) as Array<{
        path?: unknown
        objectKey?: unknown
      }>
      if (!Array.isArray(manifest) || manifest.some((item) => typeof item.path !== "string")) {
        add("malformed archive manifest", "block", archive.id)
      }
    } catch {
      add("malformed archive manifest", "block", archive.id)
    }
    if (
      archive.expires_at > snapshot.exportedAt &&
      !["completed", "failed"].includes(archive.status)
    ) {
      add("unfinished unexpired archive (rebuilt from its manifest)", "info", archive.id)
    }
  }
  for (const job of snapshot.jobs) {
    if (job.kind !== "archive") continue
    const archiveId = String((JSON.parse(job.payload) as Record<string, unknown>).archiveId)
    if (!archiveIds.has(archiveId)) add("archive job without archive", "info", job.id)
  }
  if (snapshot.rateLimits.length > 0) {
    add(
      "rate_limits rows present (table has no runtime callers)",
      "review",
      `${snapshot.rateLimits.length}`,
    )
  }

  return [...found].map(([check, { severity, ids }]) => ({
    check,
    severity,
    count: ids.length,
    sample: ids.filter(Boolean).slice(0, 10),
  }))
}

if (import.meta.main) {
  const directory = process.argv[2]
  if (!directory)
    throw new Error("Usage: bun scripts/migration/audit.ts <export-dir> [--accept-review]")
  await verifySnapshot(directory)
  const findings = audit(await readSnapshot(directory))
  await writeFile(join(directory, "audit.json"), `${JSON.stringify(findings, null, 2)}\n`)
  console.log(JSON.stringify(findings, null, 2))
  const blocking = findings.filter(
    (finding) =>
      finding.severity === "block" ||
      (finding.severity === "review" && !process.argv.includes("--accept-review")),
  )
  if (blocking.length > 0) {
    console.error(`Audit found ${blocking.length} blocking or unreviewed findings`)
    process.exitCode = 1
  }
}
