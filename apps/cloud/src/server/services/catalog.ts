import { randomUUID } from "node:crypto"
import {
  naturalCompare,
  nextAvailableName,
  previewKindForMime,
  sanitizeRelativePath,
  uploadedPreviewKeys,
} from "@cloudsync/core"
import { type CloudSyncDatabase, Database, type DatabaseError, schema } from "@cloudsync/db"
import {
  Breadcrumb,
  CloudSyncError,
  DirectoryListing,
  DownloadTicket,
  Entry,
  Ok,
  SearchResponse,
  SearchResult,
  UploadTicket,
  ObjectUploadTicket,
  PreviewManifest,
} from "@cloudsync/domain"
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { CloudConfig } from "../config"
import { folderCovers } from "./folder-covers"
import { Storage, type StorageError } from "./storage"

type EntryRow = typeof schema.entries.$inferSelect
type Transaction = Parameters<Parameters<CloudSyncDatabase["transaction"]>[0]>[0]
type DbLike = CloudSyncDatabase | Transaction
type CatalogFailure = CloudSyncError | DatabaseError | StorageError

export interface ArchiveEntry {
  readonly path: string
  readonly objectKey: string | null
}

export interface FolderArchive {
  readonly name: string
  readonly entries: ReadonlyArray<ArchiveEntry>
}

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
  readonly finalizeUpload: (uploadId: string) => Effect.Effect<Entry, CatalogFailure>
  readonly download: (id: string) => Effect.Effect<DownloadTicket, CatalogFailure>
  readonly folderArchive: (id: string) => Effect.Effect<FolderArchive, CatalogFailure>
}

const notFound = (message = "Item not found") => new CloudSyncError({ code: "NOT_FOUND", message })

const invalidInput = (message: string) => new CloudSyncError({ code: "INVALID_INPUT", message })

const PAGE_SIZE = 120
const MAX_PAGE_SIZE = 600

// Folders first, then natural name order; the "natural" ICU collation matches the client's
// numeric, case-insensitive sort so keyset pages line up with what the grid shows.
const kindRank = sql<number>`(case when ${schema.entries.kind} = 'directory' then 0 else 1 end)`
const naturalName = sql`${schema.entries.name} collate "natural"`

const CursorSchema = Schema.Tuple([Schema.Literals([0, 1]), Schema.String, Schema.String])

function encodeCursor(row: EntryRow): string {
  return Buffer.from(
    JSON.stringify([row.kind === "directory" ? 0 : 1, row.name, row.id]),
    "utf8",
  ).toString("base64url")
}

const decodeCursor = (cursor: string) =>
  Effect.try({
    try: () => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    catch: () => invalidInput("Invalid page cursor"),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(CursorSchema)(value).pipe(
        Effect.mapError(() => invalidInput("Invalid page cursor")),
      ),
    ),
    Effect.map(([rank, name, id]) => ({ rank, name, id })),
  )

type Condition = ReturnType<typeof and>

/** Covers may come from descendants; counts still describe immediate children. */
async function folderSummaries(
  db: DbLike,
  rows: ReadonlyArray<EntryRow>,
  childCondition: Condition,
) {
  const directoryIds = rows.filter((row) => row.kind === "directory").map((row) => row.id)
  if (directoryIds.length === 0) return { covers: [], counts: [] }
  const [covers, counts] = await Promise.all([
    folderCovers(db, directoryIds),
    db
      .select({ parentId: schema.entries.parentId, count: sql<number>`count(*)::int` })
      .from(schema.entries)
      .where(and(inArray(schema.entries.parentId, directoryIds), childCondition))
      .groupBy(schema.entries.parentId),
  ])
  return { covers, counts }
}

function normalizeName(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en")
}

function validateName(input: string): string {
  if (
    input.length === 0 ||
    input === "." ||
    input === ".." ||
    input.includes("/") ||
    input.includes("\0")
  ) {
    throw invalidInput("That name cannot be used")
  }
  return input
}

async function lockParent(tx: DbLike, parentId: string | null) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${parentId ?? "root"}, 0))`)
}

async function assertDirectory(tx: DbLike, parentId: string | null) {
  if (!parentId) return
  const rows = await tx
    .select({ id: schema.entries.id })
    .from(schema.entries)
    .where(
      and(
        eq(schema.entries.id, parentId),
        eq(schema.entries.kind, "directory"),
        isNull(schema.entries.deletedAt),
      ),
    )
    .limit(1)
  if (rows.length === 0) throw notFound("Destination folder not found")
}

async function requireEntry(tx: DbLike, id: string): Promise<EntryRow> {
  const rows = await tx
    .select()
    .from(schema.entries)
    .where(and(eq(schema.entries.id, id), isNull(schema.entries.deletedAt)))
    .limit(1)
  if (!rows[0]) throw notFound()
  return rows[0]
}

async function availableName(
  tx: DbLike,
  parentId: string | null,
  requested: string,
  excludeId?: string,
) {
  const conditions = [
    parentId ? eq(schema.entries.parentId, parentId) : isNull(schema.entries.parentId),
    isNull(schema.entries.deletedAt),
  ]
  if (excludeId) conditions.push(ne(schema.entries.id, excludeId))
  const rows = await tx
    .select({ name: schema.entries.name })
    .from(schema.entries)
    .where(and(...conditions))
  return nextAvailableName(
    requested,
    rows.map((row) => row.name),
  )
}

async function ensureDirectory(
  tx: DbLike,
  parentId: string | null,
  requestedName: string,
): Promise<string> {
  await lockParent(tx, parentId)
  const normalized = normalizeName(requestedName)
  const rows = await tx
    .select()
    .from(schema.entries)
    .where(
      and(
        parentId ? eq(schema.entries.parentId, parentId) : isNull(schema.entries.parentId),
        eq(schema.entries.normalizedName, normalized),
        eq(schema.entries.kind, "directory"),
        isNull(schema.entries.deletedAt),
      ),
    )
    .limit(1)
  if (rows[0]) return rows[0].id
  const name = await availableName(tx, parentId, requestedName)
  const [created] = await tx
    .insert(schema.entries)
    .values({ parentId, name, normalizedName: normalizeName(name), kind: "directory" })
    .returning()
  if (!created) throw new Error("Directory insert returned no row")
  return created.id
}

async function isDescendant(tx: DbLike, candidateId: string, ancestorId: string): Promise<boolean> {
  let id: string | null = candidateId
  while (id) {
    if (id === ancestorId) return true
    const [row] = await tx
      .select({ parentId: schema.entries.parentId })
      .from(schema.entries)
      .where(eq(schema.entries.id, id))
      .limit(1)
    id = row?.parentId ?? null
  }
  return false
}

async function subtreeIds(tx: DbLike, id: string, includeDeleted = false): Promise<Array<string>> {
  const result = await tx.execute(sql`
    with recursive subtree as (
      select id from entries where id = ${id}
      union all
      select child.id from entries child join subtree parent on child.parent_id = parent.id
    )
    select id from subtree
  `)
  const ids = Array.from(result as Iterable<{ id: string }>, (row) => row.id)
  if (ids.length === 0) throw notFound()
  if (!includeDeleted) {
    const [root] = await tx
      .select({ deletedAt: schema.entries.deletedAt })
      .from(schema.entries)
      .where(eq(schema.entries.id, id))
    if (!root || root.deletedAt) throw notFound()
  }
  return ids
}

export class Catalog extends Context.Service<Catalog, CatalogShape>()("@cloudsync/cloud/Catalog") {
  static readonly layer = Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const database = yield* Database
      const storage = yield* Storage
      const config = yield* CloudConfig

      const usesViewerCookies =
        config.cloudFrontSigning._tag === "Signed" && config.cloudFrontCookieDomain !== null
      const objectUrl = (key: string) =>
        usesViewerCookies ? Effect.succeed(storage.publicObjectUrl(key)) : storage.viewUrl(key)

      // Catalog queries throw CloudSyncError from inside Drizzle callbacks; unwrap it so the
      // client receives the real reason instead of a generic database failure.
      const run = <A>(
        name: string,
        operation: (db: CloudSyncDatabase) => Promise<A>,
      ): Effect.Effect<A, CloudSyncError | DatabaseError> =>
        database.execute(name, operation).pipe(
          Effect.catchTag("DatabaseError", (error) =>
            Schema.is(CloudSyncError)(error.cause)
              ? Effect.fail(error.cause)
              : error.reason === "unique"
                ? Effect.fail(
                    new CloudSyncError({
                      code: "CONFLICT",
                      message: "Another item with that name was created at the same time",
                    }),
                  )
                : Effect.fail<CloudSyncError | DatabaseError>(error),
          ),
        )

      const toEntry = Effect.fn("Catalog.toEntry")(function* (
        row: EntryRow,
        childCount = 0,
        coverKey?: string,
      ) {
        const thumbnailKey = row.kind === "directory" ? coverKey : row.thumbnailKey
        const thumbnailUrl = thumbnailKey ? yield* objectUrl(thumbnailKey) : null
        const previewUrl = row.previewKey ? yield* objectUrl(row.previewKey) : null
        const previewKind = row.kind === "file" ? previewKindForMime(row.mimeType) : "none"
        const previewStatus =
          previewKind === "none"
            ? "none"
            : row.thumbnailKey && row.previewKey
              ? "ready"
              : row.previewError
                ? "failed"
                : "pending"
        const contentUrl =
          previewKind !== "none" && row.objectKey ? yield* objectUrl(row.objectKey) : null
        return Entry.make({
          id: row.id,
          parentId: row.parentId,
          name: row.name,
          kind: row.kind,
          mimeType: row.mimeType,
          size: row.size,
          updatedAt: row.updatedAt.toISOString(),
          previewKind,
          previewStatus,
          isAnimated: row.isAnimated,
          thumbnailUrl,
          previewUrl,
          contentUrl,
          childCount,
        })
      })

      const list: CatalogShape["list"] = Effect.fn("Catalog.list")(function* (
        parentId,
        options = {},
      ) {
        const limit = Math.min(Math.max(1, Math.floor(options.limit ?? PAGE_SIZE)), MAX_PAGE_SIZE)
        const trashed = options.trashed ?? false
        if (trashed && !parentId) return yield* invalidInput("Choose a Recycle Bin folder")
        const after = options.cursor ? yield* decodeCursor(options.cursor) : null

        const result = yield* run("catalog.list", async (db) => {
          let directory: EntryRow | null = null
          if (parentId) {
            const [row] = await db
              .select()
              .from(schema.entries)
              .where(
                and(
                  eq(schema.entries.id, parentId),
                  eq(schema.entries.kind, "directory"),
                  trashed ? isNotNull(schema.entries.deletedAt) : isNull(schema.entries.deletedAt),
                ),
              )
              .limit(1)
            directory = row ?? null
            if (!directory) throw notFound("Folder not found")
          }
          const alive =
            trashed && directory
              ? and(
                  isNotNull(schema.entries.deletedAt),
                  eq(schema.entries.trashRootId, directory.trashRootId as string),
                )
              : isNull(schema.entries.deletedAt)

          const page = await db
            .select()
            .from(schema.entries)
            .where(
              and(
                parentId ? eq(schema.entries.parentId, parentId) : isNull(schema.entries.parentId),
                alive,
                after
                  ? sql`(${kindRank}, ${naturalName}, ${schema.entries.id}) > (${after.rank}, ${after.name} collate "natural", ${after.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(kindRank, naturalName, schema.entries.id)
            .limit(limit + 1)
          const rows = page.slice(0, limit)
          const last = rows.at(-1)
          const nextCursor = page.length > limit && last ? encodeCursor(last) : null

          const { covers, counts } = await folderSummaries(db, rows, alive)

          const chain: Array<EntryRow> = []
          let current = directory
          while (current) {
            chain.unshift(current)
            if (!current.parentId || (trashed && current.id === current.trashRootId)) break
            const [parent] = await db
              .select()
              .from(schema.entries)
              .where(eq(schema.entries.id, current.parentId))
              .limit(1)
            current = parent ?? null
          }
          return { directory, rows, nextCursor, covers, counts, chain }
        })

        const coverByParent = new Map(
          result.covers.map((cover) => [cover.parentId, cover.thumbnailKey ?? undefined]),
        )
        const countByParent = new Map(result.counts.map((count) => [count.parentId, count.count]))
        const entries = yield* Effect.forEach(
          result.rows,
          (row) => toEntry(row, countByParent.get(row.id) ?? 0, coverByParent.get(row.id)),
          { concurrency: 16 },
        )
        const directory = result.directory ? yield* toEntry(result.directory) : null
        return DirectoryListing.make({
          directory,
          breadcrumbs: [
            Breadcrumb.make({ id: null, name: trashed ? "Recycle Bin" : "CloudSync" }),
            ...result.chain.map((row) => Breadcrumb.make({ id: row.id, name: row.name })),
          ],
          entries,
          nextCursor: result.nextCursor,
        })
      })

      const search: CatalogShape["search"] = Effect.fn("Catalog.search")(function* (
        query,
        limit = 100,
      ) {
        const value = query.trim()
        if (!value) return SearchResponse.make({ results: [], truncated: false })
        const pageSize = Math.min(Math.max(1, Math.floor(limit)), 200)
        const matches = yield* run("catalog.search", async (db) => {
          const match = `%${value.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
          const result = await db.execute(sql`
            with recursive catalog_paths as (
              select id, parent_id, name, name::text as path
              from entries
              where parent_id is null and deleted_at is null
              union all
              select child.id, child.parent_id, child.name, catalog_paths.path || '/' || child.name
              from entries child
              join catalog_paths on child.parent_id = catalog_paths.id
              where child.deleted_at is null
            )
            select id, path
            from catalog_paths
            where name ilike ${match} escape '\\' or path ilike ${match} escape '\\'
            order by path
            limit ${pageSize + 1}
          `)
          const found = Array.from(result as Iterable<{ id: string; path: string }>)
          const visible = found.slice(0, pageSize)
          const ids = visible.map((row) => row.id)
          if (ids.length === 0) return { rows: [], visible, truncated: false }
          const rows = await db.select().from(schema.entries).where(inArray(schema.entries.id, ids))
          return { rows, visible, truncated: found.length > pageSize }
        })
        const rowById = new Map(matches.rows.map((row) => [row.id, row]))
        const results = yield* Effect.forEach(
          matches.visible,
          ({ id, path }) => {
            const row = rowById.get(id)
            if (!row) return Effect.succeed(null)
            const separator = path.lastIndexOf("/")
            return toEntry(row).pipe(
              Effect.map((entry) =>
                SearchResult.make({
                  entry,
                  parentPath: separator < 0 ? "CloudSync" : `CloudSync/${path.slice(0, separator)}`,
                }),
              ),
            )
          },
          { concurrency: 8 },
        )
        return SearchResponse.make({
          results: results.filter((result): result is SearchResult => result !== null),
          truncated: matches.truncated,
        })
      })

      const retryPreview: CatalogShape["retryPreview"] = Effect.fn("Catalog.retryPreview")(
        function* (id) {
          yield* run("catalog.retryPreview", (db) =>
            db.transaction(async (tx) => {
              await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 1))`)
              const entry = await requireEntry(tx, id)
              if (entry.kind !== "file" || previewKindForMime(entry.mimeType) === "none") {
                throw invalidInput("This file does not support previews")
              }
              await tx
                .update(schema.entries)
                .set({ previewError: null, updatedAt: new Date() })
                .where(eq(schema.entries.id, id))
              const active = await tx
                .select({ id: schema.jobs.id })
                .from(schema.jobs)
                .where(sql`${schema.jobs.kind} = 'preview'
                  and ${schema.jobs.payload}->>'entryId' = ${id}
                  and ${schema.jobs.status} in ('pending', 'running', 'failed')`)
                .limit(1)
              if (active.length === 0) {
                await tx.insert(schema.jobs).values({ kind: "preview", payload: { entryId: id } })
              }
            }),
          )
          return Ok.make({ ok: true })
        },
      )

      const createFolder: CatalogShape["createFolder"] = Effect.fn("Catalog.createFolder")(
        function* (parentId, requestedName) {
          const row = yield* run("catalog.createFolder", (db) =>
            db.transaction(async (tx) => {
              await lockParent(tx, parentId)
              await assertDirectory(tx, parentId)
              const name = await availableName(tx, parentId, validateName(requestedName))
              const [created] = await tx
                .insert(schema.entries)
                .values({ parentId, name, normalizedName: normalizeName(name), kind: "directory" })
                .returning()
              if (!created) throw new Error("Folder insert returned no row")
              return created
            }),
          )
          return yield* toEntry(row)
        },
      )

      const rename: CatalogShape["rename"] = Effect.fn("Catalog.rename")(
        function* (id, requestedName) {
          const row = yield* run("catalog.rename", (db) =>
            db.transaction(async (tx) => {
              const current = await requireEntry(tx, id)
              await lockParent(tx, current.parentId)
              const name = await availableName(
                tx,
                current.parentId,
                validateName(requestedName),
                id,
              )
              const [updated] = await tx
                .update(schema.entries)
                .set({ name, normalizedName: normalizeName(name), updatedAt: new Date() })
                .where(eq(schema.entries.id, id))
                .returning()
              if (!updated) throw notFound()
              return updated
            }),
          )
          return yield* toEntry(row)
        },
      )

      const move: CatalogShape["move"] = Effect.fn("Catalog.move")(function* (id, parentId) {
        const row = yield* run("catalog.move", (db) =>
          db.transaction(async (tx) => {
            const current = await requireEntry(tx, id)
            await assertDirectory(tx, parentId)
            if (parentId === id || (parentId && (await isDescendant(tx, parentId, id)))) {
              throw invalidInput("A folder cannot be moved inside itself")
            }
            await lockParent(tx, parentId)
            const name = await availableName(tx, parentId, current.name, id)
            const [updated] = await tx
              .update(schema.entries)
              .set({ parentId, name, normalizedName: normalizeName(name), updatedAt: new Date() })
              .where(eq(schema.entries.id, id))
              .returning()
            if (!updated) throw notFound()
            return updated
          }),
        )
        return yield* toEntry(row)
      })

      const trash: CatalogShape["trash"] = Effect.fn("Catalog.trash")(function* (id) {
        yield* run("catalog.trash", (db) =>
          db.transaction(async (tx) => {
            const row = await requireEntry(tx, id)
            const ids = await subtreeIds(tx, id)
            const deletedAt = new Date()
            await tx
              .update(schema.entries)
              .set({ deletedAt, trashRootId: id, updatedAt: deletedAt })
              .where(inArray(schema.entries.id, ids))
            await tx
              .update(schema.entries)
              .set({ originalParentId: row.parentId })
              .where(eq(schema.entries.id, id))
          }),
        )
        return Ok.make({ ok: true })
      })

      const recycleBin = Effect.gen(function* () {
        const result = yield* run("catalog.recycleBin", async (db) => {
          const rows = await db
            .select()
            .from(schema.entries)
            .where(
              and(
                isNotNull(schema.entries.deletedAt),
                eq(schema.entries.id, schema.entries.trashRootId),
              ),
            )
            .orderBy(kindRank, naturalName, schema.entries.id)
          // A trashed folder's direct children share its trash root, which is the folder itself.
          const summaries = await folderSummaries(
            db,
            rows,
            and(
              isNotNull(schema.entries.deletedAt),
              eq(schema.entries.trashRootId, schema.entries.parentId),
            ),
          )
          return { rows, ...summaries }
        })
        const coverByParent = new Map(
          result.covers.map((cover) => [cover.parentId, cover.thumbnailKey ?? undefined]),
        )
        const countByParent = new Map(result.counts.map((count) => [count.parentId, count.count]))
        return yield* Effect.forEach(
          result.rows,
          (row) => toEntry(row, countByParent.get(row.id) ?? 0, coverByParent.get(row.id)),
          { concurrency: 16 },
        )
      }).pipe(Effect.withSpan("Catalog.recycleBin"))

      const restore: CatalogShape["restore"] = Effect.fn("Catalog.restore")(function* (id) {
        const row = yield* run("catalog.restore", (db) =>
          db.transaction(async (tx) => {
            const [current] = await tx
              .select()
              .from(schema.entries)
              .where(and(eq(schema.entries.id, id), eq(schema.entries.trashRootId, id)))
              .limit(1)
            if (!current) throw notFound("Recycle Bin item not found")
            const parentExists = current.originalParentId
              ? (
                  await tx
                    .select({ id: schema.entries.id })
                    .from(schema.entries)
                    .where(
                      and(
                        eq(schema.entries.id, current.originalParentId),
                        isNull(schema.entries.deletedAt),
                      ),
                    )
                    .limit(1)
                ).length > 0
              : true
            const parentId = parentExists ? current.originalParentId : null
            await lockParent(tx, parentId)
            const name = await availableName(tx, parentId, current.name, id)
            const ids = await subtreeIds(tx, id, true)
            await tx
              .update(schema.entries)
              .set({ deletedAt: null, trashRootId: null, updatedAt: new Date() })
              .where(inArray(schema.entries.id, ids))
            const [updated] = await tx
              .update(schema.entries)
              .set({
                parentId,
                originalParentId: null,
                name,
                normalizedName: normalizeName(name),
              })
              .where(eq(schema.entries.id, id))
              .returning()
            if (!updated) throw notFound()
            return updated
          }),
        )
        return yield* toEntry(row)
      })

      const deletePermanently: CatalogShape["deletePermanently"] = Effect.fn(
        "Catalog.deletePermanently",
      )(function* (id) {
        yield* run("catalog.deletePermanently", (db) =>
          db.transaction(async (tx) => {
            const [root] = await tx
              .select({ id: schema.entries.id })
              .from(schema.entries)
              .where(and(eq(schema.entries.id, id), eq(schema.entries.trashRootId, id)))
              .limit(1)
            if (!root) throw notFound("Recycle Bin item not found")
            const ids = await subtreeIds(tx, id, true)
            const rows = await tx
              .select({
                objectKey: schema.entries.objectKey,
                thumbnailKey: schema.entries.thumbnailKey,
                previewKey: schema.entries.previewKey,
              })
              .from(schema.entries)
              .where(and(inArray(schema.entries.id, ids), eq(schema.entries.trashRootId, id)))
            const objectKeys = rows
              .flatMap((row) => [row.objectKey, row.thumbnailKey, row.previewKey])
              .filter((key): key is string => Boolean(key))
            await tx.insert(schema.jobs).values({ kind: "delete_objects", payload: { objectKeys } })
            await tx.delete(schema.entries).where(inArray(schema.entries.id, ids))
          }),
        )
        return Ok.make({ ok: true })
      })

      const beginUpload: CatalogShape["beginUpload"] = Effect.fn("Catalog.beginUpload")(
        function* (input) {
          if (!Number.isSafeInteger(input.size) || input.size < 0) {
            return yield* invalidInput("Invalid file size")
          }
          const parts = yield* Effect.try({
            try: () => sanitizeRelativePath(input.relativePath),
            catch: () => invalidInput("Invalid relative path"),
          })
          if (parts.at(-1) === ".DS_Store") return yield* invalidInput(".DS_Store is ignored")
          const previews = input.previews
          if (
            previews &&
            (previewKindForMime(input.mimeType) === "none" ||
              [previews.thumbnail, previews.preview].some(
                (file) =>
                  !Number.isSafeInteger(file.size) ||
                  file.size <= 0 ||
                  file.size > 32 * 1024 * 1024 ||
                  !/^[A-Za-z0-9+/]{43}=$/.test(file.checksumSha256),
              ))
          )
            return yield* invalidInput("Invalid preview manifest")
          const id = randomUUID()
          const objectKey = `objects/${id}`
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
          yield* run("upload.begin", async (db) => {
            await assertDirectory(db, input.parentId)
            await db.insert(schema.uploads).values({
              id,
              parentId: input.parentId,
              relativePath: parts.join("/"),
              objectKey,
              size: input.size,
              mimeType: input.mimeType || "application/octet-stream",
              checksumSha256: input.checksumSha256,
              previewManifest: previews,
              modifiedAt: new Date(input.modifiedAt),
              expiresAt,
            })
          })
          const signed = yield* storage.createUploadUrl(
            objectKey,
            input.mimeType,
            input.checksumSha256,
          )
          const keys = uploadedPreviewKeys(id)
          const previewTickets = previews
            ? yield* Effect.all(
                {
                  thumbnail: storage
                    .createUploadUrl(
                      keys.thumbnail,
                      "image/webp",
                      previews.thumbnail.checksumSha256,
                    )
                    .pipe(
                      Effect.map((signed) =>
                        ObjectUploadTicket.make({
                          ...signed,
                          objectKey: keys.thumbnail,
                          expiresAt: signed.expiresAt.toISOString(),
                        }),
                      ),
                    ),
                  preview: storage
                    .createUploadUrl(keys.preview, "image/webp", previews.preview.checksumSha256)
                    .pipe(
                      Effect.map((signed) =>
                        ObjectUploadTicket.make({
                          ...signed,
                          objectKey: keys.preview,
                          expiresAt: signed.expiresAt.toISOString(),
                        }),
                      ),
                    ),
                },
                { concurrency: 2 },
              )
            : undefined
          return UploadTicket.make({
            uploadId: id,
            objectKey,
            url: signed.url,
            headers: signed.headers,
            expiresAt: signed.expiresAt.toISOString(),
            ...(previewTickets ? { previews: previewTickets } : {}),
          })
        },
      )

      const finalizeUpload: CatalogShape["finalizeUpload"] = Effect.fn("Catalog.finalizeUpload")(
        function* (uploadId) {
          const upload = yield* run("upload.find", async (db) => {
            const [row] = await db
              .select()
              .from(schema.uploads)
              .where(eq(schema.uploads.id, uploadId))
              .limit(1)
            return row
          })
          if (!upload) return yield* notFound("Upload not found")
          if (upload.entryId) {
            const existing = yield* run("upload.findEntry", async (db) => {
              const [row] = await db
                .select()
                .from(schema.entries)
                .where(eq(schema.entries.id, upload.entryId as string))
                .limit(1)
              return row
            })
            if (existing) return yield* toEntry(existing)
          }

          const object = yield* storage.head(upload.objectKey).pipe(
            Effect.catchTag("StorageError", () =>
              Effect.fail(
                new CloudSyncError({
                  code: "UPLOAD_INCOMPLETE",
                  message: "The uploaded file was not found in storage",
                }),
              ),
            ),
          )
          if (
            object.ContentLength !== upload.size ||
            object.ChecksumSHA256 !== upload.checksumSha256
          ) {
            return yield* new CloudSyncError({
              code: "UPLOAD_INCOMPLETE",
              message: "The uploaded bytes did not match the source file",
            })
          }

          const manifest = upload.previewManifest
            ? yield* Schema.decodeUnknownEffect(PreviewManifest)(upload.previewManifest).pipe(
                Effect.orElseSucceed(() => null),
              )
            : null
          const keys = uploadedPreviewKeys(uploadId)
          const verifiedPreviews = manifest
            ? yield* Effect.forEach(
                ["thumbnail", "preview"] as const,
                (kind) =>
                  storage.head(keys[kind]).pipe(
                    Effect.map(
                      (object) =>
                        object.ContentLength === manifest[kind].size &&
                        object.ChecksumSHA256 === manifest[kind].checksumSha256 &&
                        object.ContentType === "image/webp",
                    ),
                    Effect.orElseSucceed(() => false),
                  ),
                { concurrency: 2 },
              ).pipe(Effect.map((verified) => verified.every(Boolean)))
            : false

          const entry = yield* run("upload.finalize", (db) =>
            db.transaction(async (tx) => {
              const [current] = await tx
                .select()
                .from(schema.uploads)
                .where(eq(schema.uploads.id, uploadId))
                .for("update")
              if (!current) throw notFound("Upload not found")
              if (current.entryId) {
                const [existing] = await tx
                  .select()
                  .from(schema.entries)
                  .where(eq(schema.entries.id, current.entryId))
                if (!existing) throw notFound()
                return existing
              }

              const parts = sanitizeRelativePath(current.relativePath)
              const fileName = validateName(parts.at(-1) as string)
              let parentId = current.parentId
              for (const directoryName of parts.slice(0, -1)) {
                parentId = await ensureDirectory(tx, parentId, validateName(directoryName))
              }
              await lockParent(tx, parentId)
              const name = await availableName(tx, parentId, fileName)
              const [created] = await tx
                .insert(schema.entries)
                .values({
                  parentId,
                  name,
                  normalizedName: normalizeName(name),
                  kind: "file",
                  objectKey: current.objectKey,
                  mimeType: current.mimeType,
                  size: current.size,
                  checksumSha256: current.checksumSha256,
                  modifiedAt: current.modifiedAt,
                  thumbnailKey: verifiedPreviews ? keys.thumbnail : null,
                  previewKey: verifiedPreviews ? keys.preview : null,
                  isAnimated: verifiedPreviews ? manifest?.isAnimated : null,
                })
                .returning()
              if (!created) throw new Error("File insert returned no row")
              await tx
                .update(schema.uploads)
                .set({ status: "finalized", entryId: created.id, updatedAt: new Date() })
                .where(eq(schema.uploads.id, uploadId))
              if (!verifiedPreviews && previewKindForMime(created.mimeType) !== "none") {
                await tx
                  .insert(schema.jobs)
                  .values({ kind: "preview", payload: { entryId: created.id } })
              }
              if (current.previewManifest && !verifiedPreviews) {
                await tx.insert(schema.jobs).values({
                  kind: "delete_objects",
                  payload: { objectKeys: Object.values(keys) },
                })
              }
              return created
            }),
          )
          return yield* toEntry(entry)
        },
      )

      const download: CatalogShape["download"] = Effect.fn("Catalog.download")(function* (id) {
        const entry = yield* run("catalog.download", async (db) => {
          const [row] = await db
            .select()
            .from(schema.entries)
            .where(
              and(
                eq(schema.entries.id, id),
                eq(schema.entries.kind, "file"),
                isNull(schema.entries.deletedAt),
              ),
            )
            .limit(1)
          return row
        })
        if (!entry?.objectKey) return yield* notFound("File not found")
        const signed = yield* storage.downloadUrl(entry.objectKey, entry.name)
        return DownloadTicket.make({ url: signed.url, expiresAt: signed.expiresAt.toISOString() })
      })

      const folderArchive: CatalogShape["folderArchive"] = Effect.fn("Catalog.folderArchive")(
        function* (id) {
          return yield* run("catalog.folderArchive", async (db) => {
            const [root] = await db
              .select()
              .from(schema.entries)
              .where(
                and(
                  eq(schema.entries.id, id),
                  eq(schema.entries.kind, "directory"),
                  isNull(schema.entries.deletedAt),
                ),
              )
              .limit(1)
            if (!root) throw notFound("Folder not found")

            const result = await db.execute(sql`
              with recursive subtree as (
                select id from entries where id = ${id} and deleted_at is null
                union all
                select child.id
                from entries child
                join subtree parent on child.parent_id = parent.id
                where child.deleted_at is null
              )
              select id from subtree
            `)
            const ids = Array.from(result as Iterable<{ id: string }>, (row) => row.id)
            const rows = await db
              .select()
              .from(schema.entries)
              .where(inArray(schema.entries.id, ids))
            const byId = new Map(rows.map((row) => [row.id, row]))
            const pathFor = (row: EntryRow): string => {
              const names = [row.name]
              let parentId = row.parentId
              while (parentId && parentId !== root.id) {
                const parent = byId.get(parentId)
                if (!parent) break
                names.unshift(parent.name)
                parentId = parent.parentId
              }
              names.unshift(root.name)
              return names.join("/")
            }

            return {
              name: root.name,
              entries: rows
                .filter((row) => row.id !== root.id)
                .map((row) => ({ path: pathFor(row), objectKey: row.objectKey }))
                .sort((a, b) => naturalCompare(a.path, b.path)),
            }
          })
        },
      )

      return Catalog.of({
        list,
        search,
        retryPreview,
        createFolder,
        rename,
        move,
        trash,
        recycleBin,
        restore,
        deletePermanently,
        beginUpload,
        finalizeUpload,
        download,
        folderArchive,
      })
    }),
  )
}
