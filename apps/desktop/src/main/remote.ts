import type { PreparedUpload } from "@cloudsync/core"
import {
  CloudSyncError,
  CloudSyncRpcs,
  type Entry,
  type Session,
  type UploadTicket,
  type ObjectUploadTicket,
} from "@cloudsync/domain"
import { NodeHttpClient } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import { DesktopConfig } from "./config"
import { describe, httpStatus } from "./describe-error"
import { cloudRpcProtocol } from "./rpc-protocol"

export class RemoteError extends Schema.TaggedError<RemoteError>()("RemoteError", {
  operation: Schema.String,
  message: Schema.String,
  unauthorized: Schema.Boolean,
  cause: Schema.Defect(),
}) {}

export interface RemoteShape {
  readonly authenticate: (token: string) => Effect.Effect<Session, RemoteError>
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

// Access answers a missing or expired token at the edge with a redirect to its login page,
// before the Worker can return an UNAUTHORIZED RPC error.
const rejectedByAccess = (cause: unknown) => [302, 401, 403].includes(httpStatus(cause) ?? 0)

const remoteError = (operation: string) => (cause: unknown) =>
  new RemoteError({
    operation,
    message: Schema.is(CloudSyncError)(cause)
      ? cause.message
      : rejectedByAccess(cause)
        ? "Your sign-in has expired"
        : describe(cause) || `Cloud ${operation} failed`,
    unauthorized:
      (Schema.is(CloudSyncError)(cause) && cause.code === "UNAUTHORIZED") ||
      rejectedByAccess(cause),
    cause,
  })

export class Remote extends Context.Service<Remote, RemoteShape>()("@cloudsync/desktop/Remote") {
  static readonly layer = Layer.effect(
    Remote,
    Effect.gen(function* () {
      const config = yield* DesktopConfig
      const fileSystem = yield* FileSystem.FileSystem
      const call = <A, E>(
        operation: string,
        token: string,
        use: (client: CloudClient) => Effect.Effect<A, E>,
      ) =>
        Effect.scoped(
          RpcClient.make(CloudSyncRpcs).pipe(
            Effect.flatMap(use),
            Effect.provide(cloudRpcProtocol(config.cloudUrl, token)),
          ),
        ).pipe(Effect.mapError(remoteError(operation)))

      const authenticate: RemoteShape["authenticate"] = (token) =>
        call("authenticate", token, (client) => client["auth.session"]())
      // A saturated uplink occasionally times out new connections to Cloudflare. Retrying just
      // the RPC keeps that from restarting a multi-gigabyte upload; finalize is idempotent.
      const retryTransport = <A>(effect: Effect.Effect<A, RemoteError>) =>
        effect.pipe(
          Effect.retry({
            times: 6,
            schedule: Schedule.exponential("1 second"),
            while: (error) => !error.unauthorized && !Schema.is(CloudSyncError)(error.cause),
          }),
        )
      const begin: RemoteShape["begin"] = (token, upload) =>
        retryTransport(call("beginUpload", token, (client) => client["upload.begin"](upload)))
      const finalize: RemoteShape["finalize"] = (token, uploadId) =>
        retryTransport(
          call("finalizeUpload", token, (client) => client["upload.finalize"]({ uploadId })),
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

      return Remote.of({ authenticate, begin, put, finalize })
    }),
  )
}
