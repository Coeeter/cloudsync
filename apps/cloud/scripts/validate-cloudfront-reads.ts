import { strict as assert } from "node:assert"
import { getSignedUrl } from "@aws-sdk/cloudfront-signer"
import { Effect, Layer, Redacted } from "effect"
import { CloudConfig } from "../src/server/config"
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
