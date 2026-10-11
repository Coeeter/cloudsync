import { createHash, randomUUID } from "node:crypto"
import { naturalCompare, sanitizeRelativePath } from "@cloudsync/core"
import { Database, type DatabaseError, type DatabaseShape, schema } from "@cloudsync/db"
import { ArchiveDownload, CloudSyncError } from "@cloudsync/domain"
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { uploadArchive } from "./archive-builder"
import { selectionRoots } from "./selection"
import { Storage, type StorageError, type StorageShape } from "./storage"

type Failure = DatabaseError | StorageError | CloudSyncError
type ArchiveRow = typeof schema.archives.$inferSelect
export const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export class Archives extends Context.Service<
  Archives,
  {
    readonly create: (ids: ReadonlyArray<string>) => Effect.Effect<ArchiveDownload, Failure>
    readonly status: (id: string) => Effect.Effect<ArchiveDownload, Failure>
  }
>()("@cloudsync/cloud/Archives") {
  static readonly layer = Layer.effect(
    Archives,
    Effect.gen(function* () {
      const database = yield* Database
      const storage = yield* Storage
      const response = (row: ArchiveRow) =>
        Effect.gen(function* () {
          const ticket =
            row.status === "completed" ? yield* storage.downloadUrl(row.objectKey, row.name) : null
          return ArchiveDownload.make({
            id: row.id,
            name: row.name,
            status: row.status,
            processed: row.processed,
            total: row.total,
            bytes: row.bytes,
            url: ticket?.url ?? null,
            error: row.error,
          })
        })
      const create = Effect.fn("Archives.create")(function* (ids: ReadonlyArray<string>) {
        const row = yield* database
          .execute("archive.create", (db) =>
            db.transaction(async (tx) => {
              const { roots, missing } = await selectionRoots(tx, ids)
              if (missing.length || roots.some(({ row }) => row.deletedAt)) {
                throw new CloudSyncError({
                  code: "NOT_FOUND",
                  message: "Some selected items are no longer available",
                })
              }
              const result = await tx.execute(sql`
          with recursive tree as (
            select id, id as root, name::text as path, object_key, kind, size from entries
            where ${inArray(
              schema.entries.id,
              roots.map(({ row }) => row.id),
            )}
            union all
            select child.id, tree.root, tree.path || '/' || child.name, child.object_key, child.kind, child.size
            from entries child join tree on child.parent_id = tree.id where child.deleted_at is null
          ) select root, path, object_key, kind, size from tree
        `)
              const prefix = new Map(
                roots.map((root) => [
                  root.row.id,
                  roots.length === 1 ? "" : root.path.slice(0, -root.row.name.length),
                ]),
              )
              const manifest = Array.from(
                result as Iterable<{
                  root: string
                  path: string
                  object_key: string | null
                  kind: "file" | "directory"
                  size: string | number
                }>,
                (entry) => {
                  const path = `${prefix.get(entry.root) ?? ""}${entry.path}${entry.kind === "directory" ? "/" : ""}`
                  if (
                    sanitizeRelativePath(path.replace(/\/$/, "")).join("/") !==
                    path.replace(/\/$/, "")
                  )
                    throw new CloudSyncError({
                      code: "INVALID_INPUT",
                      message: "Invalid archive path",
                    })
                  if (entry.kind === "file" && !entry.object_key)
                    throw new CloudSyncError({
                      code: "NOT_FOUND",
                      message: "A selected file has no stored original",
                    })
                  return { path, objectKey: entry.object_key, size: Number(entry.size) }
                },
              ).sort((a, b) => naturalCompare(a.path, b.path) || a.path.localeCompare(b.path))
              const fingerprint = createHash("sha256")
                .update(JSON.stringify(manifest))
                .digest("hex")
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${fingerprint}, 2))`,
              )
              const [existing] = await tx
                .select()
                .from(schema.archives)
                .where(
                  and(
                    eq(schema.archives.fingerprint, fingerprint),
                    gt(schema.archives.expiresAt, new Date()),
                    ne(schema.archives.status, "failed"),
                  ),
                )
                .limit(1)
              if (existing) return existing
              const id = randomUUID()
              const name =
                roots.length === 1 ? `${roots[0]?.row.name}.zip` : "CloudSync selection.zip"
              const [created] = await tx
                .insert(schema.archives)
                .values({
                  id,
                  fingerprint,
                  name,
                  objectKey: `downloads/${id}.zip`,
                  manifest,
                  total: manifest.filter((entry) => entry.objectKey !== null).length,
                  bytes: manifest.reduce((sum, entry) => sum + entry.size, 0),
                  expiresAt: new Date(Date.now() + ARCHIVE_TTL_MS),
                })
                .returning()
              if (!created) throw new Error("Archive insert returned no row")
              await tx.insert(schema.jobs).values({ kind: "archive", payload: { archiveId: id } })
              return created
            }),
          )
          .pipe(
            Effect.catchTag("DatabaseError", (error) =>
              Schema.is(CloudSyncError)(error.cause)
                ? Effect.fail(error.cause)
                : Effect.fail<Failure>(error),
            ),
          )
        return yield* response(row)
      })
      const status = Effect.fn("Archives.status")(function* (id: string) {
        const [row] = yield* database.execute("archive.status", (db) =>
          db
            .select()
            .from(schema.archives)
            .where(and(eq(schema.archives.id, id), gt(schema.archives.expiresAt, new Date())))
            .limit(1),
        )
        if (!row)
          return yield* new CloudSyncError({
            code: "NOT_FOUND",
            message: "Download expired; prepare it again",
          })
        return yield* response(row)
      })
      return Archives.of({ create, status })
    }),
  )
}

export const buildArchive = Effect.fn("Worker.buildArchive")(function* (
  id: string,
  database: DatabaseShape,
  storage: StorageShape,
) {
  const [row] = yield* database.execute("archive.begin", (db) =>
    db
      .update(schema.archives)
      .set({ status: "building", processed: 0, error: null })
      .where(eq(schema.archives.id, id))
      .returning(),
  )
  if (!row) return
  yield* uploadArchive({
    objectKey: row.objectKey,
    entries: row.manifest,
    storage,
    onProgress: (processed) =>
      database
        .execute("archive.progress", (db) =>
          db
            .update(schema.archives)
            .set({ processed: sql`greatest(${schema.archives.processed}, ${processed})` })
            .where(eq(schema.archives.id, id)),
        )
        .pipe(Effect.asVoid),
    onUploading: database
      .execute("archive.uploading", (db) =>
        db.update(schema.archives).set({ status: "uploading" }).where(eq(schema.archives.id, id)),
      )
      .pipe(Effect.asVoid),
  }).pipe(
    Effect.tapError((error) =>
      database
        .execute("archive.error", (db) =>
          db
            .update(schema.archives)
            .set({
              status: "failed",
              error: error instanceof Error ? error.message : "Archive preparation failed",
            })
            .where(eq(schema.archives.id, id)),
        )
        .pipe(Effect.asVoid),
    ),
  )
  yield* database.execute("archive.complete", (db) =>
    db
      .update(schema.archives)
      .set({ status: "completed", error: null })
      .where(eq(schema.archives.id, id)),
  )
})
