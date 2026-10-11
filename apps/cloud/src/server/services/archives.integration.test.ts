import { describe, expect, it } from "bun:test"
import { execFile } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { Database, schema } from "@cloudsync/db"
import { CloudSyncRpcs } from "@cloudsync/domain"
import { BunServices } from "@effect/platform-bun"
import { eq, inArray, sql } from "drizzle-orm"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { CloudConfig } from "../config"
import { Storage } from "./storage"
import { Worker } from "./worker"

const connection = process.env.CLOUDSYNC_TEST_DATABASE_URL
const url = process.env.CLOUDSYNC_TEST_URL
const integration = connection && url ? describe : describe.skip
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

integration("Prepared ZIP downloads through RPC, worker, S3 and CloudFront", () => {
  it("downloads ten sources concurrently, preserves bytes, reuses snapshots and performs bulk actions", async () => {
    if (
      !connection ||
      !url ||
      new URL(connection).hostname !== "127.0.0.1" ||
      new URL(connection).pathname !== "/cloudsync_worker_test" ||
      !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
    )
      throw new Error("Use a disposable local database and server")
    const config = await Effect.runPromise(CloudConfig.pipe(Effect.provide(CloudConfig.layer)))
    if (!config.s3Bucket.endsWith("-dev")) throw new Error("Use development storage only")
    const rootId = randomUUID()
    const files = Array.from({ length: 13 }, (_, index) => {
      const id = randomUUID()
      return {
        id,
        key: `objects/archive-test/${id}`,
        name: index === 0 ? "日本語.bin" : `${index}.bin`,
        content: randomBytes(768 * 1024),
      }
    })
    const fileIds = files.map((file) => file.id)
    const [firstFile, secondFile, thirdFile] = files
    if (!firstFile || !secondFile || !thirdFile) throw new Error("Missing file fixtures")
    const emptyIds = Array.from({ length: 125 }, () => randomUUID())
    const firstEmptyId = emptyIds[0]
    if (!firstEmptyId) throw new Error("Missing folder fixture")
    const otherId = randomUUID()
    const missingId = randomUUID()
    const entryIds = [rootId, ...fileIds, ...emptyIds, otherId, missingId]
    const archiveIds: string[] = []
    const keys = files.map((file) => file.key)
    const token = randomUUID()
    const tokenHash = digest(Buffer.from(token))
    const directory = await mkdtemp(join(tmpdir(), "cloudsync-archive-test-"))
    const before = new Set(await readdir(tmpdir()))
    let opened = 0
    let peak = 0
    let active = 0
    const gates: Array<() => void> = []
    const upstream = Storage.layer.pipe(Layer.provide(Layer.succeed(CloudConfig, config)))
    const gated = Layer.effect(
      Storage,
      Effect.gen(function* () {
        const storage = yield* Storage
        return Storage.of({
          ...storage,
          get: (key) =>
            storage.get(key).pipe(
              Effect.tap(() =>
                Effect.promise(async () => {
                  opened += 1
                  if (opened > 10) return
                  active += 1
                  peak = Math.max(peak, active)
                  await new Promise<void>((release) => {
                    gates.push(release)
                    if (gates.length === 10) for (const resume of gates) resume()
                  })
                  active -= 1
                }),
              ),
            ),
        })
      }),
    ).pipe(Layer.provide(upstream))
    const database = Database.layer({
      connectionString: Redacted.make(connection),
      migrationsFolder: resolve(import.meta.dirname, "../../../../../packages/db/drizzle"),
    })
    const worker = Worker.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(database, gated)),
      Layer.provide(BunServices.layer),
    )
    const protocol = RpcClient.layerProtocolHttp({ url: `${url}/rpc` }).pipe(
      Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
    )
    const layer = worker.pipe(Layer.provideMerge(protocol))
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database
          const storage = yield* Storage
          const worker = yield* Worker
          const rpc = yield* RpcClient.make(CloudSyncRpcs)
          yield* db.execute("test.fixtures", async (db) => {
            expect(await db.select().from(schema.jobs)).toHaveLength(0)
            await db.insert(schema.sessions).values({
              email: config.ownerEmail,
              tokenHash,
              expiresAt: new Date(Date.now() + 300_000),
            })
            await db.insert(schema.entries).values([
              {
                id: rootId,
                name: `archive-test-${rootId}`,
                normalizedName: `archive-test-${rootId}`,
                kind: "directory",
              },
              {
                id: otherId,
                name: `other-${rootId}`,
                normalizedName: `other-${rootId}`,
                kind: "directory",
              },
              ...files.map((file) => ({
                id: file.id,
                parentId: rootId,
                name: file.name,
                normalizedName: file.name,
                kind: "file" as const,
                objectKey: file.key,
                mimeType: "application/octet-stream",
                size: file.content.length,
              })),
              ...emptyIds.map((id, index) => ({
                id,
                parentId: rootId,
                name: `empty-${index}`,
                normalizedName: `empty-${index}`,
                kind: "directory" as const,
              })),
              {
                id: missingId,
                name: `missing-${rootId}`,
                normalizedName: `missing-${rootId}`,
                kind: "file",
                objectKey: `objects/archive-test/missing-${rootId}`,
                size: 10,
              },
            ])
          })
          yield* Effect.forEach(
            files,
            (file) => storage.put(file.key, file.content, "application/octet-stream"),
            { concurrency: 5 },
          )
          const listing = yield* rpc["catalog.list"]({ sessionToken: token, parentId: rootId })
          expect(listing.entries).toHaveLength(120)
          const all = yield* rpc["catalog.selectionIds"]({ sessionToken: token, parentId: rootId })
          expect(all).toHaveLength(138)
          const searched = yield* rpc["catalog.selectionIds"]({
            sessionToken: token,
            parentId: null,
            query: `archive-test-${rootId}`,
          })
          expect(searched).toHaveLength(139)
          const started = performance.now()
          const archive = yield* rpc["download.archive"]({
            sessionToken: token,
            ids: [rootId, firstFile.id, rootId],
          })
          archiveIds.push(archive.id)
          expect(archive.total).toBe(13)
          expect(archive.status).toBe("pending")
          const reusedPending = yield* rpc["download.archive"]({
            sessionToken: token,
            ids: [rootId],
          })
          expect(reusedPending.id).toBe(archive.id)
          expect(yield* worker.runOnce.pipe(Effect.timeout("30 seconds"))).toBe(true)
          expect(peak).toBe(10)
          const completed = yield* rpc["download.status"]({ sessionToken: token, id: archive.id })
          expect(completed.status).toBe("completed")
          expect(completed.processed).toBe(13)
          const downloadUrl = completed.url
          if (!downloadUrl) return yield* Effect.die("Completed archive has no URL")
          expect(new URL(downloadUrl).hostname).toBe(new URL(config.cloudFrontUrl).hostname)
          const downloaded = yield* Effect.promise(async () => {
            const result = await fetch(downloadUrl)
            expect(result.status).toBe(200)
            expect(result.headers.get("content-disposition")).toContain("attachment")
            return new Uint8Array(await result.arrayBuffer())
          })
          const archiveFile = join(directory, "result.zip")
          yield* Effect.promise(() => writeFile(archiveFile, downloaded))
          const inspection = yield* Effect.promise(async () => {
            const { stdout } = await promisify(execFile)("python3", [
              "-c",
              "import zipfile,hashlib,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'bad':z.testzip(),'names':z.namelist(),'methods':list(set(i.compress_type for i in z.infolist())),'hashes':{i.filename:hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir()}}))",
              archiveFile,
            ])
            return JSON.parse(stdout) as {
              bad: string | null
              names: string[]
              methods: number[]
              hashes: Record<string, string>
            }
          })
          expect(inspection.bad).toBeNull()
          expect(inspection.names).toHaveLength(139)
          expect(inspection.methods).toEqual([0])
          for (const file of files)
            expect(inspection.hashes[`archive-test-${rootId}/${file.name}`]).toBe(
              digest(file.content),
            )
          console.log(
            `Prepared and delivered ${(downloaded.length / 1e6).toFixed(1)} MB in ${((performance.now() - started) / 1000).toFixed(2)}s; peak source concurrency=${peak}`,
          )
          const cached = yield* rpc["download.archive"]({ sessionToken: token, ids: [rootId] })
          expect(cached.id).toBe(archive.id)
          expect(cached.url).not.toBeNull()
          yield* rpc["catalog.rename"]({
            sessionToken: token,
            id: firstFile.id,
            name: "renamed.bin",
          })
          const changed = yield* rpc["download.archive"]({ sessionToken: token, ids: [rootId] })
          archiveIds.push(changed.id)
          expect(changed.id).not.toBe(archive.id)
          yield* worker.runOnce
          const mixed = yield* rpc["download.archive"]({
            sessionToken: token,
            ids: [secondFile.id, otherId],
          })
          archiveIds.push(mixed.id)
          yield* worker.runOnce
          const rows = yield* db.execute("test.mixedManifest", (db) =>
            db.select().from(schema.archives).where(eq(schema.archives.id, mixed.id)),
          )
          expect(rows[0]?.manifest.map((entry) => entry.path)).toContain(
            `archive-test-${rootId}/1.bin`,
          )
          const failed = yield* rpc["download.archive"]({ sessionToken: token, ids: [missingId] })
          archiveIds.push(failed.id)
          yield* worker.runOnce
          const status = yield* rpc["download.status"]({ sessionToken: token, id: failed.id })
          expect(status.status).toBe("failed")
          expect(status.url).toBeNull()
          const moved = yield* rpc["catalog.bulk"]({
            sessionToken: token,
            ids: [secondFile.id, thirdFile.id],
            action: "move",
            parentId: otherId,
          })
          expect(moved.failed).toHaveLength(0)
          const trash = yield* rpc["catalog.bulk"]({
            sessionToken: token,
            ids: [rootId, firstFile.id],
            action: "trash",
          })
          expect(trash.succeeded).toHaveLength(2)
          expect(trash.failed).toHaveLength(0)
          const restore = yield* rpc["catalog.bulk"]({
            sessionToken: token,
            ids: [rootId],
            action: "restore",
          })
          expect(restore.failed).toHaveLength(0)
          const invalidMove = yield* rpc["catalog.bulk"]({
            sessionToken: token,
            ids: [rootId],
            action: "move",
            parentId: firstEmptyId,
          })
          expect(invalidMove.failed).toHaveLength(1)
          expect(invalidMove.failed[0]?.message).toContain("inside itself")
          const trashEmpty = yield* rpc["catalog.bulk"]({
            sessionToken: token,
            ids: [firstEmptyId],
            action: "trash",
          })
          expect(trashEmpty.failed).toHaveLength(0)
          const deleted = yield* rpc["catalog.bulk"]({
            sessionToken: token,
            ids: [firstEmptyId],
            action: "delete",
          })
          expect(deleted.failed).toHaveLength(0)
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
      const after = await readdir(tmpdir())
      expect(
        after.filter((name) => name.startsWith("cloudsync-archive-") && !before.has(name)),
      ).toHaveLength(0)
    } finally {
      for (const release of gates) release()
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database
          const storage = yield* Storage
          const archives = archiveIds.length
            ? yield* db.execute("test.archives", (db) =>
                db.select().from(schema.archives).where(inArray(schema.archives.id, archiveIds)),
              )
            : []
          yield* Effect.forEach(
            [...keys, ...archives.map((row) => row.objectKey)],
            storage.delete,
            { concurrency: 5 },
          )
          yield* db.execute("test.cleanup", async (db) => {
            if (archiveIds.length) {
              await db
                .delete(schema.jobs)
                .where(sql`${schema.jobs.payload}->>'archiveId' in ${archiveIds}`)
              await db.delete(schema.archives).where(inArray(schema.archives.id, archiveIds))
            }
            await db
              .delete(schema.jobs)
              .where(sql`${schema.jobs.payload}->>'entryId' in ${entryIds}`)
            await db.delete(schema.entries).where(inArray(schema.entries.id, entryIds))
            await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash))
          })
        }).pipe(Effect.provide(Layer.mergeAll(database, upstream)), Effect.scoped),
      )
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
