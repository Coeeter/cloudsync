import { CloudSyncRpcs } from "@cloudsync/domain"
import { Effect, Layer } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { AtomRpc } from "effect/unstable/reactivity"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"

export class CloudSync extends AtomRpc.Service<CloudSync>()("cloudsync/client/CloudSync", {
  group: CloudSyncRpcs,
  protocol: RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
  ),
}) {}

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
