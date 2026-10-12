import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"

/**
 * Exported PostgreSQL rows. Timestamps are UTC text with microseconds, bigints are text, and JSON
 * columns are their original text, so nothing passes through lossy JavaScript Date/number types.
 */
export interface LegacyEntry {
  id: string
  parent_id: string | null
  name: string
  normalized_name: string
  kind: "file" | "directory"
  object_key: string | null
  mime_type: string | null
  size: string
  checksum_sha256: string | null
  modified_at: string | null
  thumbnail_key: string | null
  preview_key: string | null
  preview_error: string | null
  is_animated: boolean | null
  deleted_at: string | null
  original_parent_id: string | null
  trash_root_id: string | null
  created_at: string
  updated_at: string
}

export interface LegacyUpload {
  id: string
  parent_id: string | null
  relative_path: string
  object_key: string
  size: string
  mime_type: string
  checksum_sha256: string
  preview_manifest: string | null
  modified_at: string
  status: "pending" | "uploaded" | "finalized" | "failed"
  error: string | null
  entry_id: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export interface LegacyPin {
  id: string
  email: string
  code_hash: string
  attempts: number
  expires_at: string
  consumed_at: string | null
  created_at: string
}

export interface LegacySession {
  id: string
  email: string
  token_hash: string
  expires_at: string
  last_seen_at: string
  created_at: string
}

export interface LegacyJob {
  id: string
  kind: string
  payload: string
  status: "pending" | "running" | "completed" | "failed"
  attempts: number
  run_after: string
  locked_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface LegacyRateLimit {
  key: string
  window_started_at: string
  count: number
}

export interface LegacyArchive {
  id: string
  fingerprint: string
  name: string
  object_key: string
  manifest: string
  status: "pending" | "building" | "uploading" | "completed" | "failed"
  processed: number
  total: number
  bytes: string
  error: string | null
  expires_at: string
  created_at: string
}

export interface LegacySnapshot {
  readonly exportedAt: string
  readonly entries: Array<LegacyEntry>
  readonly uploads: Array<LegacyUpload>
  readonly pins: Array<LegacyPin>
  readonly sessions: Array<LegacySession>
  readonly jobs: Array<LegacyJob>
  readonly rateLimits: Array<LegacyRateLimit>
  readonly archives: Array<LegacyArchive>
}

export const TABLE_FILES = {
  entries: "entries.jsonl",
  uploads: "uploads.jsonl",
  pins: "auth_pins.jsonl",
  sessions: "sessions.jsonl",
  jobs: "jobs.jsonl",
  rateLimits: "rate_limits.jsonl",
  archives: "archives.jsonl",
} as const

async function readJsonl<A>(path: string): Promise<Array<A>> {
  const rows: Array<A> = []
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })
  for await (const line of lines) if (line) rows.push(JSON.parse(line) as A)
  return rows
}

export async function readSnapshot(directory: string): Promise<LegacySnapshot> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    exportedAt: string
  }
  return {
    exportedAt: manifest.exportedAt,
    entries: await readJsonl(join(directory, TABLE_FILES.entries)),
    uploads: await readJsonl(join(directory, TABLE_FILES.uploads)),
    pins: await readJsonl(join(directory, TABLE_FILES.pins)),
    sessions: await readJsonl(join(directory, TABLE_FILES.sessions)),
    jobs: await readJsonl(join(directory, TABLE_FILES.jobs)),
    rateLimits: await readJsonl(join(directory, TABLE_FILES.rateLimits)),
    archives: await readJsonl(join(directory, TABLE_FILES.archives)),
  }
}
