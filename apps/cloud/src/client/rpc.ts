import { CloudSyncRpcs } from "@cloudsync/domain"
import { Effect, Layer } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/unstable/rpc"

const ProtocolLive = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
)

export type CloudClient = RpcClient.FromGroup<typeof CloudSyncRpcs, RpcClientError.RpcClientError>

export function runRpc<A, E>(use: (client: CloudClient) => Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      RpcClient.make(CloudSyncRpcs).pipe(Effect.flatMap(use), Effect.provide(ProtocolLive)),
    ),
  )
}

const postJson = (url: string, body: object) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))
    const response = yield* client.execute(request)
    yield* HttpClientResponse.filterStatusOk(response)
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped)

export const establishSession = (token: string | undefined) =>
  postJson("/auth/establish", token ? { token } : {})

export const logout = postJson("/auth/logout", {})
