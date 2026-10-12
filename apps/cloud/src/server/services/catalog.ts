import { randomUUID } from "node:crypto"
import { previewKindForMime, sanitizeRelativePath, uploadedPreviewKeys } from "@cloudsync/core"
import { Database, type DatabaseError, type Sqlite } from "@cloudsync/db"
import {
  Breadcrumb,
  BulkResult,
  type BulkAction,
  CloudSyncError,
  DirectoryListing,
  DownloadTicket,
  Entry,
  ObjectUploadTicket,
  Ok,
  PreviewManifest,
  SearchResponse,
  SearchResult,
  UploadTicket,
} from "@cloudsync/domain"
import { Context, Effect, Layer, Schema } from "effect"
import { invalidInput, notFound } from "../errors"
import {
  CatalogStore,
  type EntryRow,
  makeEntry,
  now,
  retry,
  validName,
} from "../persistence/catalog"
import { type Cursor, decodeCursor, pageEntries, compareEntries } from "./ordering"
import { Storage, type StorageError } from "./storage"

type CatalogFailure = CloudSyncError | DatabaseError | StorageError

export interface CatalogShape {
  readonly list: (
    parentId: string | null,
    options?: {
      readonly cursor?: string | undefined
      readonly limit?: number | undefined
      readonly trashed?: boolean | undefined
    },
  ) => Effect.Effect<DirectoryListing, CatalogFailure>
  readonly search: (query: string, limit?: number) => Effect.Effect<SearchResponse, CatalogFailure>
  readonly selectionIds: (
    parentId: string | null,
    query?: string,
    trashed?: boolean,
  ) => Effect.Effect<ReadonlyArray<string>, CatalogFailure>
  readonly bulk: (
    ids: ReadonlyArray<string>,
    action: BulkAction,
    parentId?: string | null,
  ) => Effect.Effect<BulkResult, CatalogFailure>
  readonly retryPreview: (id: string) => Effect.Effect<Ok, CatalogFailure>
  readonly createFolder: (
    parentId: string | null,
    name: string,
  ) => Effect.Effect<Entry, CatalogFailure>
  readonly rename: (id: string, name: string) => Effect.Effect<Entry, CatalogFailure>
  readonly move: (id: string, parentId: string | null) => Effect.Effect<Entry, CatalogFailure>
  readonly trash: (id: string) => Effect.Effect<Ok, CatalogFailure>
  readonly recycleBin: Effect.Effect<ReadonlyArray<Entry>, CatalogFailure>
  readonly restore: (id: string) => Effect.Effect<Entry, CatalogFailure>
  readonly deletePermanently: (id: string) => Effect.Effect<Ok, CatalogFailure>
  readonly beginUpload: (input: {
    readonly parentId: string | null
    readonly relativePath: string
    readonly size: number
    readonly mimeType: string
    readonly checksumSha256: string
    readonly modifiedAt: string
    readonly previews?: PreviewManifest | undefined
  }) => Effect.Effect<UploadTicket, CatalogFailure>
  readonly beginPreview: (
    id: string,
    previews: PreviewManifest,
  ) => Effect.Effect<UploadTicket, CatalogFailure>
  readonly finalizeUpload: (uploadId: string) => Effect.Effect<Entry, CatalogFailure>
  readonly download: (id: string) => Effect.Effect<DownloadTicket, CatalogFailure>
}

interface UploadRow {
  id: string
  parentId: string | null
  relativePath: string
  objectKey: string
  size: number
  mimeType: string
  checksumSha256: string
  previewManifest: string | null
  modifiedAt: string
  status: string
  entryId: string | null
  previewEntryId: string | null
  expiresAt: string
}
const expiry = () => new Date(Date.now() + 15 * 60_000).toISOString()
export class Catalog extends Context.Service<Catalog, CatalogShape>()("@cloudsync/cloud/Catalog") {
  static readonly layer = Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const database = yield* Database
      const storage = yield* Storage
      const run = <A>(name: string, operation: (db: Sqlite) => Promise<A>) =>
        database
          .execute(name, operation)
          .pipe(
            Effect.catchTag("DatabaseError", (error) =>
              Schema.is(CloudSyncError)(error.cause)
                ? Effect.fail(error.cause)
                : Effect.fail<CatalogFailure>(error),
            ),
          )
      const entry = (row: EntryRow) =>
        Effect.gen(function* () {
          const summary =
            row.kind === "directory"
              ? yield* run("summary", (db) => new CatalogStore(db).summary(row))
              : null
          const previewKind = previewKindForMime(row.mimeType)
          return Entry.make({
            id: row.id,
            parentId: row.parentId,
            name: row.name,
            kind: row.kind,
            mimeType: row.mimeType,
            size: row.size,
            updatedAt: row.updatedAt,
            previewKind,
            previewStatus:
              row.thumbnailKey && row.previewKey
                ? "ready"
                : previewKind === "none"
                  ? "none"
                  : row.previewError
                    ? "failed"
                    : "none",
            isAnimated: row.isAnimated === null ? null : !!row.isAnimated,
            childCount: summary?.count ?? 0,
            thumbnailUrl:
              (row.thumbnailKey ?? summary?.cover)
                ? yield* storage.viewUrl((row.thumbnailKey ?? summary?.cover) as string)
                : null,
            previewUrl: row.previewKey ? yield* storage.viewUrl(row.previewKey) : null,
            contentUrl: row.objectKey ? yield* storage.viewUrl(row.objectKey) : null,
          })
        })
      const entries = (rows: readonly EntryRow[]) => Effect.forEach(rows, entry, { concurrency: 8 })
      const list: CatalogShape["list"] = (parentId, options = {}) =>
        Effect.gen(function* () {
          const cursor: Cursor | null = options.cursor ? yield* decodeCursor(options.cursor) : null
          const result = yield* run("list", async (db) => {
            const store = new CatalogStore(db)
            const chain = parentId ? await store.chain(parentId) : []
            if (parentId) {
              if (!chain[0] || chain[0].kind !== "directory" || chain.some((e) => e.deleting))
                throw notFound()
              if (options.trashed ? !chain[0].deletedAt : chain.some((e) => e.deletedAt))
                throw notFound()
            }
            const rows =
              options.trashed && !parentId
                ? await db.all<EntryRow>(
                    "SELECT * FROM entries WHERE deletedAt IS NOT NULL AND trashRootId=id AND deleting=0",
                  )
                : await store.children(parentId, options.trashed)
            return {
              ...pageEntries(
                rows,
                Math.min(600, Math.max(1, Math.floor(options.limit ?? 120))),
                cursor,
              ),
              chain,
            }
          })
          return DirectoryListing.make({
            directory: result.chain[0] ? yield* entry(result.chain[0]) : null,
            breadcrumbs: [
              Breadcrumb.make({ id: null, name: options.trashed ? "Recycle Bin" : "CloudSync" }),
              ...result.chain
                .slice()
                .reverse()
                .map((e) => Breadcrumb.make({ id: e.id, name: e.name })),
            ],
            entries: yield* entries(result.page),
            nextCursor: result.nextCursor,
          })
        })
      const search: CatalogShape["search"] = (query, limit = 100) =>
        Effect.gen(function* () {
          if (!query.trim()) return SearchResponse.make({ results: [], truncated: false })
          const matches = yield* run("search", (db) => new CatalogStore(db).paths(query))
          const count = Math.min(200, Math.max(1, limit))
          const rows = yield* run("search.entries", (db) =>
            db.all<EntryRow & { path: string }>(
              "SELECT e.*,json_extract(j.value,'$.path') AS path FROM entries e JOIN json_each(?) j ON e.id=json_extract(j.value,'$.id') WHERE e.deletedAt IS NULL AND e.deleting=0",
              JSON.stringify(matches.slice(0, count)),
            ),
          )
          const results = yield* Effect.forEach(
            rows,
            (row) =>
              entry(row).pipe(
                Effect.map((e) =>
                  SearchResult.make({
                    entry: e,
                    parentPath: row.path.includes("/")
                      ? `CloudSync/${row.path.slice(0, row.path.lastIndexOf("/"))}`
                      : "CloudSync",
                  }),
                ),
              ),
            { concurrency: 8 },
          )
          return SearchResponse.make({ results, truncated: matches.length > count })
        })
      const selectionIds: CatalogShape["selectionIds"] = (parentId, query, trashed = false) =>
        run("selection", async (db) => {
          const store = new CatalogStore(db)
          if (query?.trim() && !trashed) return (await store.paths(query)).map((e) => e.id)
          if (parentId) {
            if (trashed) {
              const e = await store.row(parentId)
              if (!e?.deletedAt || e.deleting) throw notFound()
            } else await store.directory(parentId)
          }
          const rows =
            trashed && !parentId
              ? await db.all<EntryRow>(
                  "SELECT * FROM entries WHERE trashRootId=id AND deletedAt IS NOT NULL AND deleting=0",
                )
              : await store.children(parentId, trashed)
          return rows.sort(compareEntries).map((e) => e.id)
        })
      const createFolder: CatalogShape["createFolder"] = (parentId, name) =>
        run("createFolder", (db) => new CatalogStore(db).createDirectory(parentId, name)).pipe(
          Effect.flatMap(entry),
        )
      const rename: CatalogShape["rename"] = (id, name) =>
        run("rename", (db) => new CatalogStore(db).relocate(id, validName(name))).pipe(
          Effect.flatMap(entry),
        )
      const move: CatalogShape["move"] = (id, parentId) =>
        run("move", (db) => new CatalogStore(db).relocate(id, undefined, parentId)).pipe(
          Effect.flatMap(entry),
        )
      const trash: CatalogShape["trash"] = (id) =>
        run("trash", (db) => new CatalogStore(db).trash(id)).pipe(Effect.as(Ok.make({ ok: true })))
      const restore: CatalogShape["restore"] = (id) =>
        run("restore", (db) => new CatalogStore(db).restore(id)).pipe(Effect.flatMap(entry))
      const deletePermanently: CatalogShape["deletePermanently"] = (id) =>
        run("delete", (db) => new CatalogStore(db).markDeleting(id)).pipe(
          Effect.as(Ok.make({ ok: true })),
        )
      const recycleBin = list(null, { trashed: true }).pipe(Effect.map((l) => l.entries))
      const retryPreview: CatalogShape["retryPreview"] = () =>
        Effect.fail(invalidInput("Regenerate this preview in the browser"))
      const begin = (
        input: Parameters<CatalogShape["beginUpload"]>[0],
        previewEntryId: string | null = null,
      ) =>
        Effect.gen(function* () {
          if (
            !Number.isSafeInteger(input.size) ||
            input.size < 0 ||
            !/^[A-Za-z0-9+/]{43}=$/.test(input.checksumSha256)
          )
            return yield* invalidInput("Invalid file metadata")
          const parts = yield* Effect.try({
            try: () => sanitizeRelativePath(input.relativePath),
            catch: () => invalidInput("Invalid relative path"),
          })
          const modifiedAt = new Date(input.modifiedAt)
          if (Number.isNaN(modifiedAt.getTime()))
            return yield* invalidInput("Invalid modification time")
          const manifest = input.previews
          if (
            manifest &&
            (previewKindForMime(input.mimeType) === "none" ||
              [manifest.thumbnail, manifest.preview].some(
                (p) =>
                  !Number.isSafeInteger(p.size) ||
                  p.size <= 0 ||
                  p.size > 32 * 1024 * 1024 ||
                  !/^[A-Za-z0-9+/]{43}=$/.test(p.checksumSha256),
              ))
          )
            return yield* invalidInput("Invalid preview manifest")
          const id = randomUUID()
          const objectKey = `objects/${id}`
          const expiresAt = expiry()
          yield* run("upload.begin", async (db) => {
            const store = new CatalogStore(db)
            await store.directory(input.parentId)
            if (previewEntryId) await store.visible(previewEntryId)
            await db.run(
              "INSERT INTO uploads(id,parentId,relativePath,objectKey,size,mimeType,checksumSha256,previewManifest,modifiedAt,previewEntryId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              id,
              input.parentId,
              parts.join("/"),
              objectKey,
              input.size,
              input.mimeType,
              input.checksumSha256,
              manifest ? JSON.stringify(manifest) : null,
              modifiedAt.toISOString(),
              previewEntryId,
              expiresAt,
              now(),
              now(),
            )
          })
          const signed = yield* storage.createUploadUrl(
            objectKey,
            input.mimeType,
            input.checksumSha256,
          )
          const keys = uploadedPreviewKeys(id)
          const ticket = (key: string, p: PreviewManifest["thumbnail"]) =>
            storage.createUploadUrl(key, p.mimeType ?? "image/webp", p.checksumSha256).pipe(
              Effect.map((s) =>
                ObjectUploadTicket.make({
                  ...s,
                  objectKey: key,
                  expiresAt: s.expiresAt.toISOString(),
                }),
              ),
            )
          const previews = manifest
            ? yield* Effect.all(
                {
                  thumbnail: ticket(keys.thumbnail, manifest.thumbnail),
                  preview: ticket(keys.preview, manifest.preview),
                },
                { concurrency: 2 },
              )
            : undefined
          return UploadTicket.make({
            ...signed,
            uploadId: id,
            objectKey,
            expiresAt,
            ...(previews ? { previews } : {}),
          })
        })
      const beginUpload: CatalogShape["beginUpload"] = (input) => begin(input)
      const beginPreview: CatalogShape["beginPreview"] = (id, previews) =>
        Effect.gen(function* () {
          const row = yield* run("preview.source", (db) => new CatalogStore(db).visible(id))
          if (row.kind !== "file" || !row.checksumSha256)
            return yield* invalidInput("This file does not support preview replacement")
          return yield* begin(
            {
              parentId: row.parentId,
              relativePath: row.name,
              size: row.size,
              mimeType: row.mimeType ?? "",
              checksumSha256: row.checksumSha256,
              modifiedAt: row.modifiedAt ?? row.createdAt,
              previews,
            },
            id,
          )
        })
      const finalizeUpload: CatalogShape["finalizeUpload"] = (uploadId) =>
        Effect.gen(function* () {
          const upload = yield* run("upload.find", (db) =>
            db.first<UploadRow>("SELECT * FROM uploads WHERE id=?", uploadId),
          )
          if (!upload) return yield* notFound("Upload not found")
          if (upload.entryId) {
            const row = yield* run("upload.existing", (db) =>
              new CatalogStore(db).row(upload.entryId as string),
            )
            if (!row) return yield* notFound()
            return yield* entry(row)
          }
          if (!["pending","uploaded"].includes(upload.status) || upload.expiresAt < new Date().toISOString())
            return yield* invalidInput("Upload expired; start it again")
          if (!upload.previewEntryId) {
            const object = yield* storage.head(upload.objectKey)
            if (
              object.ContentLength !== upload.size ||
              object.ChecksumSHA256 !== upload.checksumSha256
            )
              return yield* new CloudSyncError({
                code: "UPLOAD_INCOMPLETE",
                message: "The uploaded bytes did not match the source file",
              })
          }
          const manifest = upload.previewManifest
            ? yield* Schema.decodeUnknownEffect(PreviewManifest)(
                JSON.parse(upload.previewManifest),
              ).pipe(Effect.mapError(() => invalidInput("Invalid preview manifest")))
            : null
          const keys = uploadedPreviewKeys(uploadId)
          const verified = manifest
            ? yield* Effect.forEach(
                ["thumbnail", "preview"] as const,
                (kind) =>
                  storage.head(keys[kind]).pipe(
                    Effect.map(
                      (o) =>
                        o.ContentLength === manifest[kind].size &&
                        o.ChecksumSHA256 === manifest[kind].checksumSha256 &&
                        o.ContentType === (manifest[kind].mimeType ?? "image/webp"),
                    ),
                    Effect.orElseSucceed(() => false),
                  ),
                { concurrency: 2 },
              ).pipe(Effect.map((v) => v.every(Boolean)))
            : false
          if (upload.previewEntryId && !verified)
            return yield* new CloudSyncError({
              code: "UPLOAD_INCOMPLETE",
              message: "The preview bytes did not match the manifest",
            })
          const row = yield* run("upload.finalize", (db) =>
            retry(async () => {
              const current = await db.first<UploadRow>(
                "SELECT * FROM uploads WHERE id=?",
                uploadId,
              )
              if (!current) throw notFound()
              if (current.entryId) {
                const row = await new CatalogStore(db).row(current.entryId)
                if (!row) throw notFound()
                return row
              }
              const store = new CatalogStore(db)
              let parentId = current.parentId
              if (!current.previewEntryId) {
                for (const part of sanitizeRelativePath(current.relativePath).slice(0, -1))
                  parentId = (await store.createDirectory(parentId, part, true)).id
              }
              const revision = await db.revision()
              await store.directory(parentId)
              const source = current.previewEntryId
                ? await store.visible(current.previewEntryId)
                : null
              const name =
                source?.name ??
                (await store.name(
                  parentId,
                  sanitizeRelativePath(current.relativePath).at(-1) as string,
                ))
              const row =
                source ??
                makeEntry({
                  parentId,
                  name,
                  kind: "file",
                  objectKey: current.objectKey,
                  size: current.size,
                  mimeType: current.mimeType,
                  checksumSha256: current.checksumSha256,
                  modifiedAt: current.modifiedAt,
                })
              const saved = {
                ...row,
                thumbnailKey: verified ? keys.thumbnail : row.thumbnailKey,
                previewKey: verified ? keys.preview : row.previewKey,
                isAnimated: verified
                  ? manifest?.isAnimated === null
                    ? null
                    : Number(manifest?.isAnimated)
                  : row.isAnimated,
                previewError: verified
                  ? null
                  : previewKindForMime(row.mimeType) === "none"
                    ? null
                    : "No usable client preview; retry in the browser",
                updatedAt: now(),
              }
              const cleanup = source
                ? [source.thumbnailKey, source.previewKey].filter((key): key is string => !!key)
                : current.previewManifest && !verified
                  ? Object.values(keys)
                  : []
              await db.commit(revision, [
                [
                  "INSERT INTO assertions(value) SELECT coalesce((SELECT CASE WHEN status IN ('pending','uploaded') AND entryId IS NULL THEN 1 ELSE 0 END FROM uploads WHERE id=?),0)",
                  uploadId,
                ],
                ...(source
                  ? [
                      [
                        "UPDATE entries SET thumbnailKey=?,previewKey=?,isAnimated=?,previewError=NULL,updatedAt=? WHERE id=?",
                        saved.thumbnailKey,
                        saved.previewKey,
                        saved.isAnimated,
                        saved.updatedAt,
                        row.id,
                      ] as const,
                    ]
                  : [store.insert(saved)]),
                [
                  "UPDATE uploads SET status='finalized',entryId=?,updatedAt=? WHERE id=?",
                  row.id,
                  now(),
                  uploadId,
                ],
                ...(cleanup.length
                  ? [
                      [
                        "INSERT INTO cleanup(id,objectKeys,createdAt) VALUES(?,?,?)",
                        randomUUID(),
                        JSON.stringify(cleanup),
                        now(),
                      ] as const,
                    ]
                  : []),
              ])
              return saved
            }),
          )
          return yield* entry(row)
        })
      const download: CatalogShape["download"] = (id) =>
        Effect.gen(function* () {
          const row = yield* run("download", (db) => new CatalogStore(db).visible(id))
          if (!row.objectKey) return yield* notFound("File not found")
          const ticket = yield* storage.downloadUrl(row.objectKey, row.name)
          return DownloadTicket.make({ url: ticket.url, expiresAt: ticket.expiresAt.toISOString() })
        })
      const bulk:CatalogShape["bulk"]=(ids,action,parentId)=>run("bulk",db=>new CatalogStore(db).bulk(ids,action,parentId)).pipe(Effect.map(result=>BulkResult.make(result)))
      return Catalog.of({
        list,
        search,
        selectionIds,
        bulk,
        retryPreview,
        createFolder,
        rename,
        move,
        trash,
        recycleBin,
        restore,
        deletePermanently,
        beginUpload,
        beginPreview,
        finalizeUpload,
        download,
      })
    }),
  )
}
