import { createHash, randomUUID } from "node:crypto"
import { Database, type DatabaseError, type Sqlite, type Statement } from "@cloudsync/db"
import { ArchiveDownload, CloudSyncError } from "@cloudsync/domain"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { signedHeaders, type ZipManifest } from "../../shared/zip-protocol"
import { CloudConfig } from "../config"
import { CatalogStore, now, retry } from "../persistence/catalog"
import { Storage, type StorageError } from "./storage"
export const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60_000
export interface ArchiveRow {
  id: string
  fingerprint: string
  name: string
  objectKey: string
  manifest: string
  selection: string
  status: "pending" | "building" | "uploading" | "completed" | "failed"
  processed: number
  total: number
  bytes: number
  error: string | null
  leaseToken: string | null
  leaseUntil: string | null
  submittedAt: string | null
  attempts: number
  expiresAt: string
  createdAt: string
}
type Failure = DatabaseError | StorageError | CloudSyncError
export interface ArchivesShape {
  readonly create: (ids: readonly string[]) => Effect.Effect<ArchiveDownload, Failure>
  readonly status: (id: string) => Effect.Effect<ArchiveDownload, Failure>
  readonly submit: (row: ArchiveRow) => Effect.Effect<void, Failure>
}
export class Archives extends Context.Service<Archives, ArchivesShape>()(
  "@cloudsync/cloud/Archives",
) {
  static readonly layer = Layer.effect(
    Archives,
    Effect.gen(function* () {
      const database = yield* Database
      const storage = yield* Storage
      const config = yield* CloudConfig
      const run = <A>(name: string, f: (db: Sqlite) => Promise<A>) =>
        database
          .execute(name, f)
          .pipe(
            Effect.catchTag("DatabaseError", (e) =>
              Schema.is(CloudSyncError)(e.cause) ? Effect.fail(e.cause) : Effect.fail<Failure>(e),
            ),
          )
      const response = (row: ArchiveRow) =>
        Effect.gen(function* () {
          if (row.status === "completed")
            yield* run("archive.revalidate", async (db) => {
              const pages = await db.all<{ ids: string }>(
                "SELECT ids FROM archive_selections WHERE archiveId=? ORDER BY page",
                row.id,
              )
              const ids = pages.length
                ? pages.flatMap((p) => JSON.parse(p.ids) as string[])
                : (JSON.parse(row.selection) as string[])
              if (!ids.length)
                throw new CloudSyncError({
                  code: "NOT_FOUND",
                  message: "Archive source is unavailable",
                })
              for (let start = 0; start < ids.length; start += 500) {
                const batch = [...new Set(ids.slice(start, start + 500))]
                const result = await db.first<{ count: number }>(
                  "SELECT count(*) AS count FROM entries WHERE id IN (SELECT value FROM json_each(?)) AND deletedAt IS NULL AND deleting=0",
                  JSON.stringify(batch),
                )
                if (result?.count !== batch.length)
                  throw new CloudSyncError({
                    code: "NOT_FOUND",
                    message: "Some archive items are no longer available; prepare it again",
                  })
              }
            })
          const ticket =
            row.status === "completed" ? yield* storage.downloadUrl(row.objectKey, row.name) : null
          return ArchiveDownload.make({
            id: row.id,
            name: row.name,
            status: row.status,
            processed: row.processed,
            total: row.total,
            bytes: row.bytes,
            error: row.error,
            url: ticket?.url ?? null,
          })
        })
      const submit: ArchivesShape["submit"] = (row) =>
        Effect.gen(function* () {
          if (!config.zipServiceUrl)
            return yield* new CloudSyncError({
              code: "INTERNAL",
              message: "ZIP service is not configured",
            })
          const body = JSON.stringify({
            version: 1,
            jobId: row.id,
            manifestKey: row.manifest,
            fingerprint: row.fingerprint,
          })
          yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                `${config.zipServiceUrl?.replace(/\/$/, "")}/zip/${row.id}`,
                {
                  method: "POST",
                  headers: signedHeaders(Redacted.value(config.zipServiceSecret), body),
                  body,
                  signal: AbortSignal.timeout(20_000),
                },
              )
              if (!response.ok) throw new Error("ZIP submission rejected")
            },
            catch: () =>
              new CloudSyncError({
                code: "INTERNAL",
                message: "ZIP submission will retry shortly",
              }),
          })
          yield* run("archive.submitted", (db) =>
            db.run(
              "UPDATE archives SET submittedAt=? WHERE id=? AND status='pending'",
              now(),
              row.id,
            ),
          )
        })
      const create: ArchivesShape["create"] = (ids) =>
        Effect.gen(function* () {
          const manifest = yield* run("archive.manifest", (db) =>
            retry(async () => {
              const result = await new CatalogStore(db).manifest(ids)
              if ((await db.revision()) !== result.revision)
                throw new Error("CHECK constraint: changed catalog")
              return result
            }),
          )
          const fingerprint = createHash("sha256")
            .update(JSON.stringify(manifest.entries))
            .digest("hex")
          const existing = yield* run("archive.reuse", (db) =>
            db.first<ArchiveRow>(
              "SELECT * FROM archives WHERE fingerprint=? AND expiresAt>? AND status<>'failed' ORDER BY createdAt DESC LIMIT 1",
              fingerprint,
              now(),
            ),
          )
          if (existing) return yield* response(existing)
          const id = randomUUID()
          const manifestKey = `system/zip-requests/${id}.json`
          const payload: ZipManifest = {
            version: 1,
            jobId: id,
            fingerprint,
            entries: manifest.entries,
          }
          yield* storage.put(
            manifestKey,
            new TextEncoder().encode(JSON.stringify(payload)),
            "application/json",
          )
          const row: ArchiveRow = {
            id,
            fingerprint,
            name: manifest.name,
            objectKey: `downloads/${id}.zip`,
            manifest: manifestKey,
            selection: "[]",
            status: "pending",
            processed: 0,
            total: manifest.entries.filter((e) => e.objectKey).length,
            bytes: manifest.entries.reduce((n, e) => n + e.size, 0),
            error: null,
            leaseToken: null,
            leaseUntil: null,
            submittedAt: null,
            attempts: 0,
            expiresAt: new Date(Date.now() + ARCHIVE_TTL_MS).toISOString(),
            createdAt: now(),
          }
          const selectionPages: Statement[] = Array.from(
            { length: Math.ceil(manifest.memberIds.length / 500) },
            (_, page) => [
              "INSERT INTO archive_selections(archiveId,page,ids) VALUES(?,?,?)",
              id,
              page,
              JSON.stringify(manifest.memberIds.slice(page * 500, page * 500 + 500)),
            ],
          )
          // The manifest was already checked against one catalog revision. Guarding this insert
          // with it too would fail the request whenever an unrelated upload lands meanwhile.
          yield* run("archive.create", (db) =>
            db.batch([
              [
                "INSERT INTO archives(id,fingerprint,name,objectKey,manifest,selection,total,bytes,expiresAt,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)",
                id,
                fingerprint,
                row.name,
                row.objectKey,
                manifestKey,
                row.selection,
                row.total,
                row.bytes,
                row.expiresAt,
                row.createdAt,
              ],
              ...selectionPages,
            ]),
          )
          yield* submit(row).pipe(Effect.ignore)
          return yield* response(row)
        })
      const status: ArchivesShape["status"] = (id) =>
        Effect.gen(function* () {
          const row = yield* run("archive.status", (db) =>
            db.first<ArchiveRow>("SELECT * FROM archives WHERE id=? AND expiresAt>?", id, now()),
          )
          if (!row)
            return yield* new CloudSyncError({
              code: "NOT_FOUND",
              message: "Download expired; prepare it again",
            })
          if (
            row.status === "pending" &&
            (!row.submittedAt || Date.now() - Date.parse(row.submittedAt) > 2 * 60_000)
          )
            yield* submit(row).pipe(Effect.ignore)
          return yield* response(row)
        })
      return Archives.of({ create, status, submit })
    }),
  )
}
