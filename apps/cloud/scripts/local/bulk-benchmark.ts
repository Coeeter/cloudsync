import { createHash, randomUUID } from "node:crypto"
import { CloudSyncRpcs } from "@cloudsync/domain"
import { Layer, ManagedRuntime, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { localSql } from "./d1"
const base = process.env.CLOUDSYNC_E2E_URL ?? "http://localhost:3310"
const id = randomUUID()
const token = randomUUID()
await localSql(
  "INSERT INTO sessions(id,email,tokenHash,expiresAt,lastSeenAt,createdAt) VALUES(?,?,?,?,?,?)",
  [
    id,
    "owner@example.test",
    createHash("sha256").update(token).digest("hex"),
    "2099-01-01T00:00:00Z",
    new Date().toISOString(),
    new Date().toISOString(),
  ],
)
const runtime = ManagedRuntime.make(
  RpcClient.layerProtocolHttp({ url: `${base}/rpc` }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
  ),
)
const scope = Scope.makeUnsafe()
const client = await runtime.runPromise(RpcClient.make(CloudSyncRpcs).pipe(Scope.provide(scope)))
try {
  const ids = await runtime.runPromise(
    client["catalog.selectionIds"]({ sessionToken: token, parentId: null, query: "Benchmark" }),
  )
  if (ids.length !== 74957) throw new Error("Seed the benchmark catalog first")
  const timings: number[] = []
  for (const action of ["trash", "restore"] as const) {
    const start = performance.now()
    const result = await runtime.runPromise(
      client["catalog.bulk"]({ sessionToken: token, ids, action }),
    )
    if (result.failed.length || result.succeeded.length !== ids.length)
      throw new Error(`${action} omitted selected entries`)
    const elapsedMs = Math.round(performance.now() - start)
    timings.push(elapsedMs)
    console.log(JSON.stringify({ action, entries: result.succeeded.length, elapsedMs }))
  }
  const children = await localSql<{ count: number }>(
    "SELECT count(*) AS count FROM entries WHERE parentId=? AND deletedAt IS NULL",
    ["benchmark-dir-1"],
  )
  if (children[0]?.count !== 323) throw new Error("Restore changed direct child counts")
  if (timings.some((ms) => ms > 15_000))
    throw new Error("Bulk action exceeded the local 15-second regression budget")
} finally {
  await runtime.dispose()
  await localSql("DELETE FROM sessions WHERE id=?", [id])
}
