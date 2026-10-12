import { afterAll, describe, expect, it } from "bun:test"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { Effect, Layer, Redacted } from "effect"
import { CloudConfig, type CloudConfigShape } from "../config"
import { Storage } from "./storage"

const server = Bun.serve({ port: 0, fetch: () => new Response(new Uint8Array([1, 2, 3])) })
afterAll(() => server.stop(true))
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const config: CloudConfigShape = {
  nodeEnv: "development",
  zipServiceUrl: null,
  zipServiceSecret: Redacted.make("unused"),
  ownerEmail: "fixture@example.com",
  sessionSecret: Redacted.make("unused"),
  publicUrl: "http://localhost:3000",
  awsRegion: "ap-southeast-1",
  s3Bucket: "fixture",
  s3Endpoint: "http://127.0.0.1:1",
  s3PublicEndpoint: null,
  s3ForcePathStyle: false,
  cloudFrontUrl: server.url.toString(),
  cloudFrontCookieDomain: null,
  cloudFrontSigning: {
    _tag: "Signed",
    keyPairId: "K123",
    privateKeyPem: Redacted.make(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  },
  resend: { apiKey: Redacted.make("unused"), from: "fixture@example.com" },
}
const layer = Storage.layer.pipe(Layer.provide(Layer.succeed(CloudConfig, config)))

describe("CloudFront storage reads", () => {
  it("signs the exact object and attachment filename with a five-minute expiry", async () => {
    const before = Date.now()
    const ticket = await Effect.runPromise(
      Effect.flatMap(Storage, (storage) => storage.downloadUrl("objects/a b", "日本語.zip")).pipe(
        Effect.provide(layer),
      ),
    )
    const url = new URL(ticket.url)
    expect(url.origin).toBe(server.url.origin)
    expect(url.pathname).toBe("/objects/a%20b")
    expect(url.search).not.toContain("X-Amz")
    expect(url.searchParams.get("response-content-disposition")).toContain(
      "filename*=UTF-8''%E6%97%A5",
    )
    expect(ticket.expiresAt.getTime() - before).toBeLessThanOrEqual(301_000)
    const expires = Number(url.searchParams.get("Expires"))
    const signature = Buffer.from(
      (url.searchParams.get("Signature") ?? "")
        .replaceAll("-", "+")
        .replaceAll("_", "=")
        .replaceAll("~", "/"),
      "base64",
    )
    for (const parameter of ["Expires", "Signature", "Key-Pair-Id"])
      url.searchParams.delete(parameter)
    const verifies = (resource: string) => {
      const verifier = createVerify("RSA-SHA1")
      verifier.update(
        JSON.stringify({
          Statement: [
            { Resource: resource, Condition: { DateLessThan: { "AWS:EpochTime": expires } } },
          ],
        }),
      )
      verifier.end()
      return verifier.verify(publicKey, signature)
    }
    expect(verifies(url.toString())).toBe(true)
    url.pathname = "/objects/other"
    expect(verifies(url.toString())).toBe(false)
  })

  it("streams from the CDN even when S3 is unreachable", async () => {
    const object = await Effect.runPromise(
      Effect.flatMap(Storage, (storage) => storage.get("objects/fixture")).pipe(
        Effect.provide(layer),
      ),
    )
    const chunks = []
    for await (const chunk of object.body) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]))
  })
})
