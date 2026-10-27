import type { PreparedUpload } from "@cloudsync/core"
import {
  CloudSyncError,
  CloudSyncRpcs,
  type Entry,
  type UploadTicket,
  type ObjectUploadTicket,
} from "@cloudsync/domain"
import { NodeHttpClient } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/unstable/rpc"
import { DesktopConfig } from "./config"
import { describe } from "./describe-error"

export class RemoteError extends Schema.TaggedError<RemoteError>()("RemoteError", {
  operation: Schema.String,
  message: Schema.String,
  unauthorized: Schema.Boolean,
  cause: Schema.Defect(),
}) {}

export interface RemoteShape {
  readonly requestPin: (email: string) => Effect.Effect<void, RemoteError>
  readonly verifyPin: (email: string, code: string) => Effect.Effect<string, RemoteError>
  readonly authenticate: (token: string) => Effect.Effect<void, RemoteError>
  readonly begin: (
    token: string,
    upload: PreparedUpload,
  ) => Effect.Effect<UploadTicket, RemoteError>
  readonly put: (
    ticket: ObjectUploadTicket,
    body: Uint8Array | { readonly path: string },
  ) => Effect.Effect<void, RemoteError>
  readonly finalize: (token: string, uploadId: string) => Effect.Effect<Entry, RemoteError>
}

type CloudClient = RpcClient.FromGroup<typeof CloudSyncRpcs, RpcClientError.RpcClientError>

const remoteError = (operation: string) => (cause: unknown) =>
  new RemoteError({
    operation,
    message: Schema.is(CloudSyncError)(cause)
      ? cause.message
      : describe(cause) || `Cloud ${operation} failed`,
    unauthorized: Schema.is(CloudSyncError)(cause) && cause.code === "UNAUTHORIZED",
    cause,
  })

export class Remote extends Context.Service<Remote, RemoteShape>()("@cloudsync/desktop/Remote") {
  static readonly layer = Layer.effect(
    Remote,
    Effect.gen(function* () {
      const config = yield* DesktopConfig
      const fileSystem = yield* FileSystem.FileSystem
      const protocol = RpcClient.layerProtocolHttp({ url: `${config.cloudUrl}/rpc` }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
      )
      const call = <A, E>(operation: string, use: (client: CloudClient) => Effect.Effect<A, E>) =>
        Effect.scoped(
          RpcClient.make(CloudSyncRpcs).pipe(Effect.flatMap(use), Effect.provide(protocol)),
        ).pipe(Effect.mapError(remoteError(operation)))

      const requestPin: RemoteShape["requestPin"] = (email) =>
        call("requestPin", (client) => client["auth.requestPin"]({ email })).pipe(Effect.asVoid)
      const verifyPin: RemoteShape["verifyPin"] = (email, code) =>
        call("verifyPin", (client) =>
          client["auth.verifyPin"]({ email, code, client: "desktop" }),
        ).pipe(
          Effect.flatMap((session) =>
            session.token
              ? Effect.succeed(session.token as string)
              : Effect.fail(remoteError("verifyPin")(new Error("Server did not return a session"))),
          ),
        )
      const authenticate: RemoteShape["authenticate"] = (sessionToken) =>
        call("authenticate", (client) => client["auth.session"]({ sessionToken })).pipe(
          Effect.asVoid,
        )
      // A saturated uplink occasionally times out new connections to Cloudflare. Retrying just
      // the RPC keeps that from restarting a multi-gigabyte upload; finalize is idempotent.
      const retryTransport = <A>(effect: Effect.Effect<A, RemoteError>) =>
        effect.pipe(
          Effect.retry({
            times: 6,
            schedule: Schedule.exponential("1 second"),
            while: (error) => !Schema.is(CloudSyncError)(error.cause),
          }),
        )
      const begin: RemoteShape["begin"] = (sessionToken, upload) =>
        retryTransport(
          call("beginUpload", (client) => client["upload.begin"]({ sessionToken, ...upload })),
        )
      const finalize: RemoteShape["finalize"] = (sessionToken, uploadId) =>
        retryTransport(
          call("finalizeUpload", (client) => client["upload.finalize"]({ sessionToken, uploadId })),
        )
      // Originals stream from disk so large videos are never held in memory. Presigned S3 PUTs
      // reject chunked bodies, and node:http sends the exact Content-Length that bodyFile sets.
      const put: RemoteShape["put"] = (ticket, body) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          const request = HttpClientRequest.put(ticket.url)
          const withBody =
            body instanceof Uint8Array
              ? HttpClientRequest.bodyUint8Array(request, body)
              : yield* HttpClientRequest.bodyFile(request, body.path)
          const response = yield* client.execute(
            HttpClientRequest.setHeaders(withBody, ticket.headers),
          )
          if (response.status >= 300) {
            const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
            const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
            return yield* remoteError("uploadBytes")(
              new Error(
                `Storage rejected the upload (HTTP ${response.status}${code ? ` ${code}` : ""})`,
              ),
            )
          }
        }).pipe(
          Effect.provide(NodeHttpClient.layerNodeHttp),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.scoped,
          Effect.catchTags({
            PlatformError: (cause) =>
              remoteError("uploadBytes")(new Error(`Could not read the file: ${describe(cause)}`)),
            HttpClientError: (cause) =>
              remoteError("uploadBytes")(new Error(`Could not reach storage: ${describe(cause)}`)),
          }),
        )

      return Remote.of({ requestPin, verifyPin, authenticate, begin, put, finalize })
    }),
  )
}
