import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { Database, schema } from "@cloudsync/db"
import { BunServices } from "@effect/platform-bun"
import { and, eq, inArray } from "drizzle-orm"
import { Effect, Layer, Redacted } from "effect"
import { CloudConfig } from "../config"
import { Storage } from "./storage"
import { Worker } from "./worker"

const connection = process.env.CLOUDSYNC_TEST_DATABASE_URL
const integration = connection ? describe : describe.skip
integration("Preview worker with real persistence and development CDN", () => {
  it("creates previews and terminates decode failures after one download", async () => {
    if (!connection || new URL(connection).hostname !== "127.0.0.1")
      throw new Error("Use a throwaway local test database")
    const config = await Effect.runPromise(CloudConfig.pipe(Effect.provide(CloudConfig.layer)))
    if (!config.s3Bucket.endsWith("-dev")) throw new Error("Use development storage only")
    const database = Database.layer({
      connectionString: Redacted.make(connection),
      migrationsFolder: resolve(import.meta.dirname, "../../../../../packages/db/drizzle"),
    })
    const infrastructure = Layer.mergeAll(
      database,
      Storage.layer.pipe(Layer.provide(Layer.succeed(CloudConfig, config))),
    )
    const layer = Worker.layer.pipe(
      Layer.provideMerge(infrastructure),
      Layer.provide(BunServices.layer),
    )
    const badId = crypto.randomUUID()
    const goodId = crypto.randomUUID()
    const missingId = crypto.randomUUID()
    const ids = [badId, goodId, missingId]
    const badKey = `objects/cdn-validation/${badId}.webp`
    const goodKey = `objects/cdn-validation/${goodId}.png`
    const missingKey = `objects/cdn-validation/${missingId}.png`
    const keys = [badKey, goodKey]
    const badWebP = Buffer.from("524946460c00000057454250414e494d00000000", "hex")
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZXkAAAAASUVORK5CYII=",
      "base64",
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database
        const storage = yield* Storage
        const worker = yield* Worker
        yield* Effect.gen(function* () {
          yield* storage.put(badKey, badWebP, "image/webp")
          yield* storage.put(goodKey, png, "image/png")
          yield* db.execute("fixture", async (client) => {
            await client.insert(schema.entries).values(
              ids.map((id, index) => ({
                id,
                name: `fixture-${id}`,
                normalizedName: `fixture-${id}`,
                kind: "file" as const,
                objectKey: [badKey, goodKey, missingKey][index],
                mimeType: index === 0 ? "image/webp" : "image/png",
                size: index === 0 ? badWebP.length : png.length,
              })),
            )
            await client
              .insert(schema.jobs)
              .values(ids.map((entryId) => ({ kind: "preview", payload: { entryId } })))
          })
          for (let count = 0; count < 3; count++) yield* worker.runOnce
          const rows = yield* db.execute("inspect", (client) =>
            client.select().from(schema.entries).where(inArray(schema.entries.id, ids)),
          )
          const jobs = yield* db.execute("inspect", (client) => client.select().from(schema.jobs))
          const badJob = jobs.find((job) => (job.payload as { entryId?: string }).entryId === badId)
          const missingJob = jobs.find(
            (job) => (job.payload as { entryId?: string }).entryId === missingId,
          )
          if (!badJob || !missingJob) return yield* Effect.die("Fixture jobs are missing")
          expect(badJob.status).toBe("completed")
          expect(badJob.attempts).toBe(1)
          expect(badJob.error).not.toBeNull()
          expect(rows.find((row) => row.id === badId)?.previewError).not.toBeNull()
          expect(missingJob.status).toBe("failed")
          expect(missingJob.attempts).toBe(1)
          const good = rows.find((row) => row.id === goodId)
          if (!good?.thumbnailKey || !good.previewKey)
            return yield* Effect.die("Fixture preview is missing")
          expect(good.thumbnailKey).not.toBeNull()
          expect(good.previewKey).not.toBeNull()
          expect(good.previewError).toBeNull()
          keys.push(good.thumbnailKey, good.previewKey)
          const object = yield* storage.get(good.thumbnailKey)
          const header = yield* Effect.promise(async () => {
            const chunks = []
            for await (const chunk of object.body) chunks.push(chunk)
            return Buffer.concat(chunks).subarray(0, 4).toString()
          })
          expect(header).toBe("RIFF")
          // Terminal decode errors are not retried, and the download retry is delayed.
          expect(yield* worker.runOnce).toBe(false)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Effect.forEach(keys, storage.delete, { discard: true })
              yield* db.execute("cleanup", async (client) => {
                await client.delete(schema.jobs).where(
                  and(
                    eq(schema.jobs.kind, "preview"),
                    inArray(
                      schema.jobs.payload,
                      ids.map((entryId) => ({ entryId })),
                    ),
                  ),
                )
                await client.delete(schema.entries).where(inArray(schema.entries.id, ids))
              })
            }).pipe(Effect.orDie),
          ),
        )
      }).pipe(Effect.provide(layer)),
    )
  }, 60_000)
})
