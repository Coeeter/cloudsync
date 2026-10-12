import { Database } from "@cloudsync/db"
import { Effect } from "effect"
import { uploadedPreviewKeys } from "@cloudsync/core"
import { CatalogStore, now, retry } from "./persistence/catalog"
import { Archives, type ArchiveRow } from "./services/archives"
import { Storage } from "./services/storage"
import { applyZipCallback, type ZipCallback } from "./zip-callback"

export const maintenance = Effect.gen(function* () {
  const database = yield* Database
  const storage = yield* Storage
  const archives = yield* Archives
  const pending = yield* database.execute("maintenance.archives", (db) =>
    db.all<ArchiveRow>(
      "SELECT * FROM archives WHERE (status='pending' OR (status IN ('building','uploading') AND leaseUntil<?)) AND expiresAt>? ORDER BY createdAt LIMIT 20",
      now(),
      now(),
    ),
  )
  for (const row of pending) {
    if (row.leaseToken) {
      const outcome = yield* storage
        .readJson(`system/zip-outcomes/${row.id}/${row.leaseToken}.json`)
        .pipe(Effect.orElseSucceed(() => null))
      if (outcome) {
        const response = yield* applyZipCallback(outcome as ZipCallback).pipe(
          Effect.orElseSucceed(() => null),
        )
        if (response?.status === 200) continue
      }
      // A hard-killed archive cannot safely be retried without knowing its multipart outcome.
      yield* database.execute("maintenance.expiredLease", (db) =>
        db.run(
          "UPDATE archives SET status='failed',error='ZIP exceeded Lambda limits or the worker stopped; prepare it again' WHERE id=? AND leaseToken=? AND leaseUntil<? AND status IN ('building','uploading')",
          row.id,
          row.leaseToken,
          now(),
        ),
      )
    } else yield* archives.submit(row).pipe(Effect.ignore)
  }
  const expiredTrash = yield* database.execute("maintenance.trash", (db) =>
    db.all<{ id: string }>(
      "SELECT id FROM entries WHERE trashRootId=id AND deletedAt<? AND deleting=0 LIMIT 20",
      new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
    ),
  )
  for (const row of expiredTrash)
    yield* database
      .execute("maintenance.markDeleting", (db) => new CatalogStore(db).markDeleting(row.id))
      .pipe(Effect.ignore)
  const expired = yield* database.execute("maintenance.uploads", (db) =>
    db.all<{ id: string; objectKey: string; previewManifest: string | null }>(
      "SELECT id,objectKey,previewManifest FROM uploads WHERE status IN ('pending','uploaded','failed') AND entryId IS NULL AND expiresAt<? LIMIT 100",
      new Date(Date.now() - 60 * 60_000).toISOString(),
    ),
  )
  for (const upload of expired)
    yield* database
      .execute("maintenance.abandon", (db) =>
        retry(async () => {
          const keys = [
            upload.objectKey,
            ...(upload.previewManifest ? Object.values(uploadedPreviewKeys(upload.id)) : []),
          ]
          await db.batch([
            [
              "INSERT INTO cleanup(id,objectKeys,createdAt) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM uploads WHERE id=? AND status IN ('pending','uploaded','failed') AND entryId IS NULL)",
              upload.id,
              JSON.stringify(keys),
              now(),
              upload.id,
            ],
            [
              "DELETE FROM uploads WHERE id=? AND status IN ('pending','uploaded','failed') AND entryId IS NULL",
              upload.id,
            ],
          ])
        }),
      )
      .pipe(Effect.ignore)
  const expiredArchives = yield* database.execute("maintenance.expiredArchives", (db) =>
    db.all<ArchiveRow>("SELECT * FROM archives WHERE expiresAt<? LIMIT 100", now()),
  )
  for (const row of expiredArchives)
    yield* database.execute("maintenance.expireArchive", (db) =>
      db.batch([
        [
          "INSERT OR IGNORE INTO cleanup(id,objectKeys,createdAt) VALUES(?,?,?)",
          `archive-${row.id}`,
          JSON.stringify([
            row.objectKey,
            row.manifest,
            ...(row.leaseToken ? [`system/zip-outcomes/${row.id}/${row.leaseToken}.json`] : []),
          ]),
          now(),
        ],
        ["DELETE FROM archives WHERE id=?", row.id],
      ]),
    )
  const jobs = yield* database.execute("maintenance.cleanup", (db) =>
    db.all<{ id: string; objectKeys: string }>("SELECT * FROM cleanup ORDER BY createdAt LIMIT 10"),
  )
  for (const job of jobs) {
    const success = yield* Effect.forEach(
      JSON.parse(job.objectKeys) as string[],
      (key) => storage.delete(key),
      { concurrency: 4 },
    ).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (success)
      yield* database.execute("maintenance.cleaned", (db) =>
        db.run("DELETE FROM cleanup WHERE id=?", job.id),
      )
  }
  yield* database.execute("maintenance.metadata", (db) =>
    db.batch([
      ["DELETE FROM entries WHERE deleting=1"],
      ["DELETE FROM sessions WHERE expiresAt<?", now()],
      [
        "DELETE FROM auth_pins WHERE expiresAt<? AND createdAt<?",
        now(),
        new Date(Date.now() - 15 * 60_000).toISOString(),
      ],
    ]),
  )
})
