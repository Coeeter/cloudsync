import { describe, expect, it } from "bun:test"
import { CloudSyncRpcs } from "@cloudsync/domain"
import { Effect } from "effect"
import { RpcClient } from "effect/unstable/rpc"
import { cloudRpcProtocol } from "./rpc-protocol"

describe("cloudRpcProtocol", () => {
  it("sends the Access token as an HTTP header, where Access can see it", async () => {
    const seen = { token: null as string | null, body: "" }
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.token = request.headers.get("cf-access-token")
        seen.body = await request.text()
        return new Response(null, { status: 302, headers: { location: "https://login.test" } })
      },
    })
    try {
      await Effect.runPromise(
        RpcClient.make(CloudSyncRpcs).pipe(
          Effect.flatMap((client) => client["auth.session"]()),
          Effect.flip,
          Effect.scoped,
          Effect.provide(cloudRpcProtocol(server.url.origin, "access-jwt")),
        ),
      )
      expect(seen.token).toBe("access-jwt")
      expect(seen.body).not.toContain("access-jwt")
    } finally {
      server.stop(true)
    }
  })
})
