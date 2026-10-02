import { Readable } from "node:stream"
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  type HeadObjectOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import {
  getSignedUrl as getCloudFrontSignedUrl,
  getSignedCookies,
} from "@aws-sdk/cloudfront-signer"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
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
  readonly head: (objectKey: string) => Effect.Effect<HeadObjectOutput, StorageError>
  readonly get: (objectKey: string) => Effect.Effect<{ readonly body: Readable }, StorageError>
  readonly put: (
    objectKey: string,
    body: Uint8Array,
    contentType: string,
  ) => Effect.Effect<void, StorageError>
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

      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new S3Client({
              region: config.awsRegion,
              endpoint: config.s3Endpoint ?? undefined,
              forcePathStyle: config.s3ForcePathStyle,
              requestChecksumCalculation: "WHEN_REQUIRED",
            }),
        ),
        (s3) => Effect.sync(() => s3.destroy()),
      )
      const uploadClient = config.s3PublicEndpoint
        ? yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new S3Client({
                  region: config.awsRegion,
                  endpoint: config.s3PublicEndpoint as string,
                  forcePathStyle: config.s3ForcePathStyle,
                  requestChecksumCalculation: "WHEN_REQUIRED",
                }),
            ),
            (s3) => Effect.sync(() => s3.destroy()),
          )
        : client
      const send = <A>(operation: string, thunk: () => Promise<A>) =>
        Effect.tryPromise({ try: thunk, catch: storageError(operation) }).pipe(
          Effect.withSpan(`Storage.${operation}`),
        )

      const createUploadUrl: StorageShape["createUploadUrl"] = Effect.fn("Storage.createUploadUrl")(
        function* (objectKey, mimeType, checksumSha256) {
          const command = new PutObjectCommand({
            Bucket: config.s3Bucket,
            Key: objectKey,
            ContentType: mimeType,
            ChecksumSHA256: checksumSha256,
          })
          const url = yield* send("createUploadUrl", () =>
            // The browser sends these as headers, so they must be signed rather than hoisted into the query.
            getSignedUrl(uploadClient, command, {
              expiresIn: UPLOAD_TTL_SECONDS,
              signableHeaders: new Set(["content-type", "x-amz-checksum-sha256"]),
              unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
            }),
          )
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
        send("head", () =>
          client.send(
            new HeadObjectCommand({
              Bucket: config.s3Bucket,
              Key: objectKey,
              ChecksumMode: "ENABLED",
            }),
          ),
        )

      const put: StorageShape["put"] = (objectKey, body, contentType) =>
        send("put", () =>
          client.send(
            new PutObjectCommand({
              Bucket: config.s3Bucket,
              Key: objectKey,
              Body: body,
              ContentType: contentType,
            }),
          ),
        ).pipe(Effect.asVoid)

      const remove: StorageShape["delete"] = (objectKey) =>
        send("delete", () =>
          client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: objectKey })),
        ).pipe(Effect.asVoid)

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
        delete: remove,
        viewUrl,
        downloadUrl,
        publicObjectUrl,
        signedViewerCookies,
      })
    }),
  )
}
