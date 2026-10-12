import { Readable } from "node:stream"
import { AwsClient } from "aws4fetch"
import {
  getSignedUrl as getCloudFrontSignedUrl,
  getSignedCookies,
} from "@aws-sdk/cloudfront-signer"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { CloudConfig } from "../config"

const UPLOAD_TTL_SECONDS = 15 * 60
const DOWNLOAD_TTL_SECONDS = 5 * 60
// Listing URLs back lazily loaded thumbnails, so they must outlive a long browsing session.
const VIEW_TTL_SECONDS = 6 * 60 * 60
export const VIEWER_COOKIE_TTL_SECONDS = 24 * 60 * 60

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface StorageShape {
  readonly createUploadUrl: (
    objectKey: string,
    mimeType: string,
    checksumSha256: string,
  ) => Effect.Effect<
    {
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
      readonly expiresAt: Date
    },
    StorageError
  >
  readonly head: (
    objectKey: string,
  ) => Effect.Effect<
    { ContentLength: number; ChecksumSHA256: string | null; ContentType: string | null },
    StorageError
  >
  readonly get: (objectKey: string) => Effect.Effect<{ readonly body: Readable }, StorageError>
  readonly put: (
    objectKey: string,
    body: Uint8Array,
    contentType: string,
  ) => Effect.Effect<void, StorageError>
  readonly readJson: (key: string) => Effect.Effect<unknown, StorageError>
  readonly delete: (objectKey: string) => Effect.Effect<void, StorageError>
  readonly viewUrl: (objectKey: string) => Effect.Effect<string, StorageError>
  readonly downloadUrl: (
    objectKey: string,
    fileName: string,
  ) => Effect.Effect<{ readonly url: string; readonly expiresAt: Date }, StorageError>
  readonly publicObjectUrl: (objectKey: string) => string
  readonly signedViewerCookies: Effect.Effect<Readonly<Record<string, string>> | null, StorageError>
}

const storageError = (operation: string) => (cause: unknown) =>
  new StorageError({
    operation,
    message: cause instanceof Error ? cause.message : `Storage ${operation} failed`,
    cause,
  })

export class Storage extends Context.Service<Storage, StorageShape>()("@cloudsync/cloud/Storage") {
  static readonly layer = Layer.effect(
    Storage,
    Effect.gen(function* () {
      const config = yield* CloudConfig
      const signing = config.cloudFrontSigning

      const client = new AwsClient({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
        sessionToken: process.env.AWS_SESSION_TOKEN,
        region: config.awsRegion,
        service: "s3",
        retries: 2,
      })
      const objectUrl = (key: string, publicEndpoint = false) => {
        const endpoint = (publicEndpoint ? config.s3PublicEndpoint : null) ?? config.s3Endpoint
        const base = endpoint
          ? `${endpoint.replace(/\/$/, "")}/${config.s3Bucket}`
          : `https://${config.s3Bucket}.s3.${config.awsRegion}.amazonaws.com`
        return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`
      }
      const fetchObject = async (
        key: string,
        method: string,
        body?: Uint8Array,
        contentType?: string,
      ) => {
        const response = await client.fetch(objectUrl(key), {
          method,
          body: body as Uint8Array<ArrayBuffer> | undefined,
          headers: contentType ? { "content-type": contentType } : undefined,
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) throw new Error(`Storage returned HTTP ${response.status}`)
        return response
      }
      const send = <A>(operation: string, thunk: () => Promise<A>) =>
        Effect.tryPromise({ try: thunk, catch: storageError(operation) }).pipe(
          Effect.withSpan(`Storage.${operation}`),
        )

      const createUploadUrl: StorageShape["createUploadUrl"] = Effect.fn("Storage.createUploadUrl")(
        function* (objectKey, mimeType, checksumSha256) {
          const headers = { "content-type": mimeType, "x-amz-checksum-sha256": checksumSha256 }
          const target = new URL(objectUrl(objectKey, true))
          target.searchParams.set("X-Amz-Expires", String(UPLOAD_TTL_SECONDS))
          const request = yield* send("createUploadUrl", () =>
            client.sign(target.toString(), {
              method: "PUT",
              headers,
              aws: { signQuery: true, allHeaders: true },
            }),
          )
          const url = request.url
          return {
            url,
            headers: {
              "content-type": mimeType,
              "x-amz-checksum-sha256": checksumSha256,
            },
            expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
          }
        },
      )

      const head: StorageShape["head"] = (objectKey) =>
        send("head", async () => {
          const response = await client.fetch(objectUrl(objectKey), {
            method: "HEAD",
            headers: { "x-amz-checksum-mode": "ENABLED" },
            signal: AbortSignal.timeout(20_000),
          })
          if (!response.ok) throw new Error(`Storage returned HTTP ${response.status}`)
          return {
            ContentLength: Number(response.headers.get("content-length")),
            ChecksumSHA256: response.headers.get("x-amz-checksum-sha256"),
            ContentType: response.headers.get("content-type"),
          }
        })
      const put: StorageShape["put"] = (key, body, type) =>
        send("put", () => fetchObject(key, "PUT", body, type)).pipe(Effect.asVoid)
      const remove: StorageShape["delete"] = (key) =>
        send("delete", () => fetchObject(key, "DELETE")).pipe(Effect.asVoid)

      const publicObjectUrl = (objectKey: string) =>
        `${config.cloudFrontUrl.replace(/\/$/, "")}/${objectKey
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`

      // Snapping expiry to a fixed window keeps each object's signed URL identical across
      // listings, so browsers reuse cached images instead of refetching on every render.
      const viewExpiry = () => {
        const window = VIEW_TTL_SECONDS * 1000
        return new Date(Math.ceil((Date.now() + window) / window) * window)
      }

      const viewUrl: StorageShape["viewUrl"] = Effect.fn("Storage.viewUrl")((objectKey) =>
        Effect.try({
          try: () =>
            signing._tag === "Signed"
              ? getCloudFrontSignedUrl({
                  url: publicObjectUrl(objectKey),
                  keyPairId: signing.keyPairId,
                  privateKey: Redacted.value(signing.privateKeyPem),
                  dateLessThan: viewExpiry().toISOString(),
                })
              : publicObjectUrl(objectKey),
          catch: () =>
            new StorageError({
              operation: "viewUrl",
              message: "Could not sign the CloudFront view",
              cause: null,
            }),
        }),
      )

      const readUrl = (objectKey: string, expiresAt: Date, fileName?: string) => {
        const url = new URL(publicObjectUrl(objectKey))
        if (fileName) {
          const fallback = fileName.replaceAll(/[^\x20-\x7e]|["\\]/g, "_")
          url.searchParams.set(
            "response-content-disposition",
            `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          )
        }
        if (signing._tag === "LocalUnsigned") return url.toString()
        return getCloudFrontSignedUrl({
          url: url.toString(),
          keyPairId: signing.keyPairId,
          privateKey: Redacted.value(signing.privateKeyPem),
          dateLessThan: expiresAt.toISOString(),
        })
      }

      const get: StorageShape["get"] = (objectKey) =>
        Effect.tryPromise({
          try: async (signal) => {
            const url = readUrl(objectKey, new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000))
            const response = await fetch(url, {
              signal,
              redirect: "error",
              headers: { "accept-encoding": "identity" },
            })
            if (!response.ok) throw new Error(`CloudFront returned HTTP ${response.status}`)
            if (!response.body) throw new Error("CloudFront returned an empty body")
            return {
              body: Readable.fromWeb(
                response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
              ),
            }
          },
          catch: () =>
            new StorageError({
              operation: "get",
              message: "Could not read the CloudFront object",
              cause: null,
            }),
        })

      const downloadUrl: StorageShape["downloadUrl"] = Effect.fn("Storage.downloadUrl")(
        function* (objectKey, fileName) {
          const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000)
          const url = yield* Effect.try({
            try: () => readUrl(objectKey, expiresAt, fileName),
            catch: () =>
              new StorageError({
                operation: "downloadUrl",
                message: "Could not sign the CloudFront download",
                cause: null,
              }),
          })
          return { url, expiresAt }
        },
      )

      const signedViewerCookies = Effect.try({
        try: () => {
          if (signing._tag === "LocalUnsigned") return null
          const cookies = getSignedCookies({
            keyPairId: signing.keyPairId,
            privateKey: Redacted.value(signing.privateKeyPem),
            policy: JSON.stringify({
              Statement: [
                {
                  Resource: `${config.cloudFrontUrl.replace(/\/$/, "")}/*`,
                  Condition: {
                    DateLessThan: {
                      "AWS:EpochTime": Math.floor(Date.now() / 1000) + VIEWER_COOKIE_TTL_SECONDS,
                    },
                  },
                },
              ],
            }),
          })
          const result: Record<string, string> = {
            "CloudFront-Signature": cookies["CloudFront-Signature"],
            "CloudFront-Key-Pair-Id": cookies["CloudFront-Key-Pair-Id"],
          }
          if (cookies["CloudFront-Policy"]) {
            result["CloudFront-Policy"] = cookies["CloudFront-Policy"]
          }
          return result
        },
        catch: storageError("signedViewerCookies"),
      })

      return Storage.of({
        createUploadUrl,
        head,
        get,
        put,
        readJson: (key) => send("readJson", async () => (await fetchObject(key, "GET")).json()),
        delete: remove,
        viewUrl,
        downloadUrl,
        publicObjectUrl,
        signedViewerCookies,
      })
    }),
  )
}
