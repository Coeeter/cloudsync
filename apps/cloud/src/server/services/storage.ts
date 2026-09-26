import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectOutput,
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
  readonly get: (objectKey: string) => Effect.Effect<GetObjectOutput, StorageError>
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

      const get: StorageShape["get"] = (objectKey) =>
        send("get", () =>
          client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: objectKey })),
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

      const viewUrl: StorageShape["viewUrl"] = Effect.fn("Storage.viewUrl")(function* (objectKey) {
        if (signing._tag === "Signed") {
          return getCloudFrontSignedUrl({
            url: publicObjectUrl(objectKey),
            keyPairId: signing.keyPairId,
            privateKey: Redacted.value(signing.privateKeyPem),
            dateLessThan: new Date(Date.now() + VIEW_TTL_SECONDS * 1000).toISOString(),
          })
        }
        return yield* send("viewUrl", () =>
          getSignedUrl(client, new GetObjectCommand({ Bucket: config.s3Bucket, Key: objectKey }), {
            expiresIn: VIEW_TTL_SECONDS,
          }),
        )
      })

      // CloudFront does not forward response-content-disposition to the origin, so explicit
      // downloads are presigned against S3 to get an attachment with the logical file name.
      const downloadUrl: StorageShape["downloadUrl"] = Effect.fn("Storage.downloadUrl")(
        function* (objectKey, fileName) {
          const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000)
          const fallback = fileName.replaceAll(/[^\x20-\x7e]|["\\]/g, "_")
          const url = yield* send("downloadUrl", () =>
            getSignedUrl(
              client,
              new GetObjectCommand({
                Bucket: config.s3Bucket,
                Key: objectKey,
                ResponseContentDisposition: `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
              }),
              { expiresIn: DOWNLOAD_TTL_SECONDS },
            ),
          )
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
