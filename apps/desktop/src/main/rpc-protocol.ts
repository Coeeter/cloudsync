import { Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"

// The protocol's client already fails with HttpClientError, so this adds no new error type.
const rejectNonOk = HttpClient.filterStatusOk as <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
) => HttpClient.HttpClient.With<E, R>

// Redirects are not followed so that Access's redirect to its login page surfaces as a status
// error instead of an HTML page the RPC decoder cannot parse.
export const cloudRpcProtocol = (cloudUrl: string) =>
  RpcClient.layerProtocolHttp({ url: `${cloudUrl}/rpc`, transformClient: rejectNonOk }).pipe(
    Layer.provide([
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      ),
      RpcSerialization.layerJson,
    ]),
  )
