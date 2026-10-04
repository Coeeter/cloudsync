import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { Database, schema } from "@cloudsync/db"
import { BunServices } from "@effect/platform-bun"
import { eq } from "drizzle-orm"
import { Effect, Layer, Redacted } from "effect"
import { CloudConfig } from "../config"
import { Storage } from "./storage"
import { Worker } from "./worker"

const connection = process.env.CLOUDSYNC_TEST_DATABASE_URL
const integration = connection ? describe : describe.skip

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker progress")
    await Bun.sleep(20)
  }
}

integration("Concurrent preview processing with real database and storage", () => {
  it("keeps four jobs in flight and refills a free slot without duplicate claims", async () => {
    if (
      !connection ||
      new URL(connection).hostname !== "127.0.0.1" ||
      new URL(connection).pathname !== "/cloudsync_worker_test"
    )
      throw new Error("Use a throwaway local test database")
    const config = await Effect.runPromise(CloudConfig.pipe(Effect.provide(CloudConfig.layer)))
    if (!config.s3Bucket.endsWith("-dev")) throw new Error("Use development storage only")
    const releases: Array<() => void> = []
    let releaseAll = false
    const upstream = Storage.layer.pipe(Layer.provide(Layer.succeed(CloudConfig, config)))
    // Gate real CDN responses so concurrency is deterministic regardless of network speed.
    const gatedStorage = Layer.effect(
      Storage,
      Effect.gen(function* () {
        const storage = yield* Storage
        return Storage.of({
          ...storage,
          get: (key) =>
            storage.get(key).pipe(
              Effect.tap(() =>
                Effect.promise(async () => {
                  if (!releaseAll) await new Promise<void>((release) => releases.push(release))
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
    const layer = Worker.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(database, gatedStorage)),
      Layer.provide(BunServices.layer),
    )
    const ids = Array.from({ length: 8 }, () => crypto.randomUUID())
    const keys = ids.map((id) => `objects/concurrency/${id}.png`)
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZXkAAAAASUVORK5CYII=",
      "base64",
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Database
          const storage = yield* Storage
          const worker = yield* Worker
          const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
          yield* Effect.gen(function* () {
            yield* Effect.forEach(keys, (key) => storage.put(key, png, "image/png"))
            yield* db.execute("fixture", async (sql) => {
              // The test owns the entire disposable database so sweeps cannot claim unrelated jobs.
              expect(await sql.select().from(schema.jobs)).toHaveLength(0)
              await sql.insert(schema.entries).values(
                ids.map((id, index) => ({
                  id,
                  name: id,
                  normalizedName: id,
                  kind: "file" as const,
                  objectKey: keys[index],
                  mimeType: "image/png",
                  size: png.length,
                })),
              )
              await sql.insert(schema.jobs).values(
                ids.map((entryId) => ({
                  kind: "preview",
                  payload: { entryId },
                })),
              )
            })
            const inspect = Effect.promise(async () => {
              const jobs = () =>
                runPromise(db.execute("inspect", (sql) => sql.select().from(schema.jobs)))
              await waitFor(() => releases.length === 4)
              expect((await jobs()).filter((job) => job.status === "running")).toHaveLength(4)
              releases[0]?.()
              await waitFor(() => releases.length === 5)
              expect((await jobs()).filter((job) => job.status === "running")).toHaveLength(4)
              expect((await jobs()).filter((job) => job.status === "completed")).toHaveLength(1)
              releaseAll = true
              for (const release of releases) release()
              await waitFor(async () => (await jobs()).every((job) => job.status === "completed"))
              const completed = await jobs()
              expect(completed).toHaveLength(8)
              expect(completed.every((job) => job.attempts === 1 && job.error === null)).toBe(true)
              const entries = await runPromise(
                db.execute("inspect", (sql) => sql.select().from(schema.entries)),
              )
              expect(entries.every((entry) => entry.thumbnailKey && entry.previewKey)).toBe(true)
            })
            yield* Effect.raceFirst(worker.run, inspect)
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                releaseAll = true
                for (const release of releases) release()
                const entries = yield* db.execute("cleanup", (sql) =>
                  sql.select().from(schema.entries),
                )
                const generated = entries
                  .flatMap((entry) => [entry.thumbnailKey, entry.previewKey])
                  .filter((key): key is string => key !== null)
                yield* Effect.forEach([...keys, ...generated], storage.delete, { discard: true })
                yield* db.execute("cleanup", async (sql) => {
                  await sql.delete(schema.jobs).where(eq(schema.jobs.kind, "preview"))
                  await sql.delete(schema.entries)
                })
              }).pipe(Effect.orDie),
            ),
          )
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      releaseAll = true
      for (const release of releases) release()
    }
  }, 30_000)
})
