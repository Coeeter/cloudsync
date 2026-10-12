import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import postgres from "postgres"
import { TABLE_FILES } from "./legacy"

/**
 * Exports every legacy table from one REPEATABLE READ, read-only snapshot into checksummed JSONL.
 * Usage: MIGRATION_SOURCE_URL=postgres://… bun scripts/migration/export.ts <empty-output-dir>
 * Run only after the old web and worker are stopped. It never writes to the source database.
 */
const source = process.env.MIGRATION_SOURCE_URL
const output = process.argv[2]
if (!source || !output) throw new Error("Set MIGRATION_SOURCE_URL and pass an output directory")
await mkdir(output, { recursive: true })
if ((await readdir(output)).length > 0) throw new Error("The output directory must be empty")

const ts = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${column}`

const queries: Record<keyof typeof TABLE_FILES, string> = {
  entries: `select id, parent_id, name, normalized_name, kind, object_key, mime_type, size::text as size,
    checksum_sha256, ${ts("modified_at")}, thumbnail_key, preview_key, preview_error, is_animated,
    ${ts("deleted_at")}, original_parent_id, trash_root_id, ${ts("created_at")}, ${ts("updated_at")}
    from entries order by id`,
  uploads: `select id, parent_id, relative_path, object_key, size::text as size, mime_type, checksum_sha256,
    preview_manifest::text as preview_manifest, ${ts("modified_at")}, status, error, entry_id,
    ${ts("expires_at")}, ${ts("created_at")}, ${ts("updated_at")} from uploads order by id`,
  pins: `select id, email, code_hash, attempts, ${ts("expires_at")}, ${ts("consumed_at")}, ${ts("created_at")}
    from auth_pins order by id`,
  sessions: `select id, email, token_hash, ${ts("expires_at")}, ${ts("last_seen_at")}, ${ts("created_at")}
    from sessions order by id`,
  jobs: `select id, kind, payload::text as payload, status, attempts, ${ts("run_after")}, ${ts("locked_at")},
    error, ${ts("created_at")}, ${ts("updated_at")} from jobs order by id`,
  rateLimits: `select key, ${ts("window_started_at")}, count from rate_limits order by key, window_started_at`,
  archives: `select id, fingerprint, name, object_key, manifest::text as manifest, status, processed, total,
    bytes::text as bytes, error, ${ts("expires_at")}, ${ts("created_at")} from archives order by id`,
}

const sql = postgres(source, { max: 1, prepare: false })
const counts: Record<string, number> = {}
let exportedAt = ""
try {
  await sql.begin("isolation level repeatable read read only", async (tx) => {
    const [clock] = await tx.unsafe<Array<{ now: string }>>(
      `select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`,
    )
    exportedAt = clock?.now as string
    for (const [table, query] of Object.entries(queries) as Array<
      [keyof typeof TABLE_FILES, string]
    >) {
      const stream = createWriteStream(join(output, TABLE_FILES[table]), "utf8")
      let rows = 0
      for await (const batch of tx.unsafe(query).cursor(1000)) {
        for (const row of batch) {
          if (!stream.write(`${JSON.stringify(row)}\n`)) {
            await new Promise((resolve) => stream.once("drain", resolve))
          }
          rows += 1
        }
      }
      await new Promise<void>((resolve, reject) =>
        stream.end((error?: Error) => (error ? reject(error) : resolve())),
      )
      counts[table] = rows
    }
  })
} finally {
  await sql.end()
}

const files: Record<string, { rows: number; sha256: string }> = {}
for (const [table, file] of Object.entries(TABLE_FILES)) {
  files[file] = {
    rows: counts[table] ?? 0,
    sha256: createHash("sha256")
      .update(await readFile(join(output, file)))
      .digest("hex"),
  }
}
const sourceUrl = new URL(source)
await writeFile(
  join(output, "manifest.json"),
  `${JSON.stringify(
    {
      format: 1,
      exportedAt,
      source: { host: sourceUrl.hostname, database: sourceUrl.pathname.slice(1) },
      files,
    },
    null,
    2,
  )}\n`,
)
console.log(JSON.stringify({ exportedAt, counts }, null, 2))
