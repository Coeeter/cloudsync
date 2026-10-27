import { describe as suite, expect, it } from "bun:test"
import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { HttpClientErrorSchema } from "effect/unstable/http/HttpClientError"
import { RpcClientError } from "effect/unstable/rpc"
import { describe } from "./describe-error"

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
