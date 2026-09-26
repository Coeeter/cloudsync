import type { PreparedUpload } from "@cloudsync/core"
import { CloudSyncError, CloudSyncRpcs, type Entry, type UploadTicket } from "@cloudsync/domain"
import { Context, Effect, Layer, Schema } from "effect"
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
  readonly put: (ticket: UploadTicket, bytes: Uint8Array) => Effect.Effect<void, RemoteError>
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
      const put: RemoteShape["put"] = (ticket, bytes) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          const request = HttpClientRequest.put(ticket.url).pipe(
            HttpClientRequest.bodyUint8Array(bytes),
            HttpClientRequest.setHeaders(ticket.headers),
          )
          const response = yield* client.execute(request)
          yield* HttpClientResponse.filterStatusOk(response)
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.scoped,
          Effect.mapError((cause) =>
            remoteError("uploadBytes")(
              new Error(
                cause.response
                  ? `Storage rejected the upload (HTTP ${cause.response.status})`
                  : "Could not reach storage",
              ),
            ),
          ),
        )

      return Remote.of({ requestPin, verifyPin, authenticate, begin, put, finalize })
    }),
  )
}
