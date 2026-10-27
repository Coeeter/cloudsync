import type { PreparedUpload } from "@cloudsync/core"
import {
  CloudSyncError,
  CloudSyncRpcs,
  type Entry,
  type UploadTicket,
  type ObjectUploadTicket,
} from "@cloudsync/domain"
import { NodeHttpClient } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/unstable/rpc"
import { DesktopConfig } from "./config"

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
    message:
      Schema.is(CloudSyncError)(cause) || cause instanceof Error
        ? cause.message
        : `Cloud ${operation} failed`,
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
      const begin: RemoteShape["begin"] = (sessionToken, upload) =>
        call("beginUpload", (client) => client["upload.begin"]({ sessionToken, ...upload }))
      const finalize: RemoteShape["finalize"] = (sessionToken, uploadId) =>
        call("finalizeUpload", (client) => client["upload.finalize"]({ sessionToken, uploadId }))
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
          yield* HttpClientResponse.filterStatusOk(response)
        }).pipe(
          Effect.provide(NodeHttpClient.layerNodeHttp),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.scoped,
          Effect.mapError((cause) =>
            remoteError("uploadBytes")(
              new Error(
                "response" in cause && cause.response
                  ? `Storage rejected the upload (HTTP ${cause.response.status})`
                  : cause._tag === "PlatformError"
                    ? "Could not read the file"
                    : "Could not reach storage",
              ),
            ),
          ),
        )

      return Remote.of({ requestPin, verifyPin, authenticate, begin, put, finalize })
    }),
  )
}
