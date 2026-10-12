import { createHash, randomUUID } from "node:crypto"
import { CloudSyncRpcs } from "@cloudsync/domain"
import { Layer, ManagedRuntime, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { localSql } from "./d1"
const base = process.env.CLOUDSYNC_E2E_URL ?? "http://localhost:3310"
const token = randomUUID()
const id = randomUUID()
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
  let start = performance.now()
  const listing = await runtime.runPromise(
    client["catalog.list"]({ sessionToken: token, parentId: "benchmark-dir-1" }),
  )
  console.log(
    JSON.stringify({
      boundary: "RPC children",
      items: listing.entries.length,
      elapsedMs: Math.round(performance.now() - start),
    }),
  )
  start = performance.now()
  const search = await runtime.runPromise(
    client["catalog.search"]({ sessionToken: token, query: "Benchmark/Folder 1/IMG_2", limit: 10 }),
  )
  console.log(
    JSON.stringify({
      boundary: "RPC search",
      items: search.results.length,
      elapsedMs: Math.round(performance.now() - start),
    }),
  )
  let ids = await runtime.runPromise(
    client["catalog.selectionIds"]({ sessionToken: token, parentId: null, query: "Benchmark" }),
  )
  if (ids.length < 74723) throw new Error("Seed the benchmark catalog first")
  console.log(JSON.stringify({ boundary: "RPC selection", items: ids.length }))
  if (process.env.BENCH_IDS) ids = ids.slice(0, Number(process.env.BENCH_IDS))
  start = performance.now()
  const archive = await runtime.runPromise(client["download.archive"]({ sessionToken: token, ids }))
  if (archive.total !== 74723) throw new Error("Archive manifest omitted selected entries")
  console.log(
    JSON.stringify({
      boundary: "RPC all-results archive preparation",
      selection: ids.length,
      total: archive.total,
      status: archive.status,
      elapsedMs: Math.round(performance.now() - start),
    }),
  )
} finally {
  await runtime.dispose()
  await localSql("DELETE FROM sessions WHERE id=?", [id])
}
