import { describe as suite, expect, it } from "bun:test"
import { CloudSyncRpcs } from "@cloudsync/domain"
import { Effect } from "effect"
import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { HttpClientErrorSchema } from "effect/unstable/http/HttpClientError"
import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { describe, httpStatus } from "./describe-error"
import { cloudRpcProtocol } from "./rpc-protocol"

suite("describe", () => {
  it("recovers the socket cause hidden behind an RPC HttpError", () => {
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })
    const transport = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request: HttpClientRequest.post("https://example.test/rpc"),
        cause: Object.assign(new TypeError("fetch failed"), { cause: socket }),
      }),
    })
    const error = new RpcClientError.RpcClientError({
      reason: HttpClientErrorSchema.fromHttpClientError(transport),
    })
    expect(error.message).toBe("HttpError: ")
    const text = describe(error)
    expect(text).toContain("TransportError")
    expect(text).toContain("UND_ERR_SOCKET")
    expect(text).toContain("other side closed")
  })
})

suite("httpStatus", () => {
  it("finds the redirect Access returns instead of an RPC response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { location: "https://login.test" } }),
    })
    try {
      const protocol = cloudRpcProtocol(server.url.origin)
      const error = await Effect.runPromise(
        RpcClient.make(CloudSyncRpcs).pipe(
          Effect.flatMap((client) => client["auth.session"]()),
          Effect.flip,
          Effect.scoped,
          Effect.provide(protocol),
        ),
      )
      expect(httpStatus(error)).toBe(302)
    } finally {
      server.stop(true)
    }
  })
})
