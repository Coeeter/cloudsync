import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { getSignedUrl } from "@aws-sdk/cloudfront-signer"
import { Database, schema } from "@cloudsync/db"
import { eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Redacted } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { CloudConfig } from "../src/server/config"
import { RoutesLive } from "../src/server/layers"
import { Storage } from "../src/server/services/storage"

const config = await Effect.runPromise(CloudConfig.pipe(Effect.provide(CloudConfig.layer)))
if (!config.s3Bucket.endsWith("-dev") || config.cloudFrontSigning._tag !== "Signed")
  throw new Error("Validation requires signed development CDN storage")
const signing = config.cloudFrontSigning
const key = `objects/cdn-validation/${crypto.randomUUID()}.bin`
const layer = Storage.layer.pipe(Layer.provide(Layer.succeed(CloudConfig, config)))
await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* Storage
    yield* Effect.gen(function* () {
      yield* storage.put(key, new Uint8Array([1, 2, 3, 4]), "application/octet-stream")
      const ticket = yield* storage.downloadUrl(key, "日本語.bin")
      yield* Effect.tryPromise(async () => {
        const first = await fetch(ticket.url)
        assert.equal(first.status, 200)
        assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [1, 2, 3, 4])
        assert.ok(first.headers.get("content-disposition")?.includes("filename*=UTF-8''%E6%97%A5"))
        const range = await fetch(ticket.url, { headers: { Range: "bytes=1-2" } })
        assert.equal(range.status, 206)
        assert.deepEqual([...new Uint8Array(await range.arrayBuffer())], [2, 3])
        const unsigned = new URL(ticket.url)
        for (const name of ["Expires", "Signature", "Key-Pair-Id"])
          unsigned.searchParams.delete(name)
        assert.equal((await fetch(unsigned)).status, 403)
        const tampered = new URL(ticket.url)
        tampered.searchParams.set(
          "response-content-disposition",
          'attachment; filename="other.bin"',
        )
        assert.equal((await fetch(tampered)).status, 403)
        const expired = getSignedUrl({
          url: unsigned.toString(),
          keyPairId: signing.keyPairId,
          privateKey: Redacted.value(signing.privateKeyPem),
          dateLessThan: new Date(Date.now() - 10_000).toISOString(),
        })
        assert.equal((await fetch(expired)).status, 403)
      })
      const second = yield* storage.downloadUrl(key, "second.bin")
      yield* Effect.tryPromise(async () => {
        const response = await fetch(second.url)
        assert.ok(response.headers.get("content-disposition")?.includes('filename="second.bin"'))
        await response.body?.cancel()
      })
      console.log(
        "PASS: real signed CDN download, Unicode and isolated filenames, range, unsigned/tampered/expired rejection after cache warm-up",
      )
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* storage.delete(key)
        }),
      ),
    )
  }).pipe(Effect.provide(layer)),
)

const connection = process.env.CLOUDSYNC_TEST_DATABASE_URL
if (connection) {
  if (new URL(connection).hostname !== "127.0.0.1")
    throw new Error("Use a disposable local database")
  if (Redacted.value(config.databaseUrl) !== connection)
    throw new Error(
      "Set DATABASE_URL to the test database before launching; preserve only that value through Doppler",
    )
  const handler = HttpRouter.toWebHandler(RoutesLive, { disableLogger: true })
  const folderId = crypto.randomUUID()
  const entryId = crypto.randomUUID()
  const token = crypto.randomUUID()
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const source = `objects/cdn-validation/${entryId}.bin`
  const database = Database.layer({ connectionString: Redacted.make(connection) })
  const infrastructure = Layer.mergeAll(database, layer)
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Database
      const storage = yield* Storage
      yield* Effect.gen(function* () {
        yield* storage.put(source, new Uint8Array([1, 2, 3, 4]), "application/octet-stream")
        yield* db.execute("fixture", async (client) => {
          await client.insert(schema.sessions).values({
            email: config.ownerEmail.trim().toLowerCase(),
            tokenHash,
            expiresAt: new Date(Date.now() + 60_000),
          })
          await client.insert(schema.entries).values([
            {
              id: folderId,
              name: `fixture-${folderId}`,
              normalizedName: `fixture-${folderId}`,
              kind: "directory",
            },
            {
              id: entryId,
              parentId: folderId,
              name: "fixture.bin",
              normalizedName: "fixture.bin",
              kind: "file",
              objectKey: source,
              mimeType: "application/octet-stream",
              size: 4,
            },
          ])
        })
        yield* Effect.tryPromise(async () => {
          const endpoint = `http://localhost/download/folder/${folderId}`
          const denied = await handler.handler(new Request(endpoint), Context.empty())
          assert.equal(denied.status, 404)
          const response = await handler.handler(
            new Request(endpoint, { headers: { cookie: `cloudsync_session=${token}` } }),
            Context.empty(),
          )
          assert.equal(response.status, 200)
          assert.equal(response.headers.get("content-type"), "application/zip")
          await writeFile(
            "/tmp/cloudsync-cdn-validation.zip",
            new Uint8Array(await response.arrayBuffer()),
          )
          console.log(
            "PASS: real folder-download HTTP route rejects unauthenticated requests and streams a ZIP using authorized CDN inputs",
          )
        })
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* storage.delete(source)
            yield* db.execute("cleanup", async (client) => {
              await client
                .delete(schema.entries)
                .where(inArray(schema.entries.id, [entryId, folderId]))
              await client.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash))
            })
            yield* Effect.promise(() => handler.dispose())
          }),
        ),
      )
    }).pipe(Effect.provide(infrastructure)),
  )
}
