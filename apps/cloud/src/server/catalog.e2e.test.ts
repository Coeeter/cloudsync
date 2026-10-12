import { beforeAll, afterAll, describe, expect, it } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { CloudSyncRpcs, type Entry } from "@cloudsync/domain"
import { type Effect, Layer, ManagedRuntime, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { localSql } from "../../scripts/local/d1"
const url = process.env.CLOUDSYNC_E2E_URL
const enabled = !!url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname)
const runtime = ManagedRuntime.make(
  RpcClient.layerProtocolHttp({ url: `${url}/rpc` }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
  ),
)
const scope = Scope.makeUnsafe()
const client = enabled
  ? await runtime.runPromise(RpcClient.make(CloudSyncRpcs).pipe(Scope.provide(scope)))
  : (null as never)
type Client = typeof client
const token = randomUUID()
const sessionId = randomUUID()
function call<K extends keyof Client>(
  tag: K,
  input: Omit<Parameters<Client[K]>[0], "sessionToken">,
): Promise<Effect.Success<ReturnType<Client[K]>>> {
  const rpc = client[tag] as unknown as (input: unknown) => Effect.Effect<unknown, unknown>
  return runtime.runPromise(rpc({ ...input, sessionToken: token })) as never
}
async function upload(
  parentId: string | null,
  path: string,
  bytes = new Uint8Array([1, 2, 3]),
  mimeType = "application/octet-stream",
) {
  const ticket = await call("upload.begin", {
    parentId,
    relativePath: path,
    size: bytes.length,
    mimeType,
    checksumSha256: createHash("sha256").update(bytes).digest("base64"),
    modifiedAt: new Date().toISOString(),
  })
  const response = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: bytes })
  expect(response.ok).toBe(true)
  return { ticket, entry: await call("upload.finalize", { uploadId: ticket.uploadId }) }
}
let root: Entry
const suite = enabled ? describe : describe.skip
suite("Workers RPC with real local D1 and S3", () => {
  beforeAll(async () => {
    await localSql(
      "INSERT INTO sessions(id,email,tokenHash,expiresAt,lastSeenAt,createdAt) VALUES(?,?,?,?,?,?)",
      [
        sessionId,
        "owner@example.test",
        createHash("sha256").update(token).digest("hex"),
        "2099-01-01T00:00:00Z",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    )
    root = await call("catalog.createFolder", { parentId: null, name: `e2e-${randomUUID()}` })
  })
  afterAll(async () => {
    await localSql("DELETE FROM sessions WHERE id=?", [sessionId])
    await runtime.dispose()
  })
  it("finalizes once and reserves concurrent sibling names", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => upload(root.id, "Shared/photo2.dat")),
    )
    expect(new Set(results.map((r) => r.entry.name)).size).toBe(6)
    const first = results[0]
    if (!first) throw new Error("No upload result")
    const again = await call("upload.finalize", { uploadId: first?.ticket.uploadId as string })
    expect(again.id).toBe(first?.entry.id)
    const listing = await call("catalog.list", { parentId: root.id })
    expect(listing.entries.filter((e) => e.name === "Shared")).toHaveLength(1)
    expect(listing.entries[0]?.childCount).toBe(6)
  }, 30_000)
  it("rejects opposite moves, pages naturally and searches paths", async () => {
    const a = await call("catalog.createFolder", { parentId: root.id, name: "A" })
    const b = await call("catalog.createFolder", { parentId: root.id, name: "B" })
    const moves = await Promise.allSettled([
      call("catalog.move", { id: a.id, parentId: b.id }),
      call("catalog.move", { id: b.id, parentId: a.id }),
    ])
    expect(moves.filter((m) => m.status === "rejected")).toHaveLength(1)
    const dir = await call("catalog.createFolder", { parentId: root.id, name: "Paging" })
    for (const name of ["file10.dat", "file2.dat", "file1.dat"]) await upload(dir.id, name)
    const first = await call("catalog.list", { parentId: dir.id, limit: 2 })
    expect(first.entries.map((e) => e.name)).toEqual(["file1.dat", "file2.dat"])
    const second = await call("catalog.list", {
      parentId: dir.id,
      limit: 2,
      cursor: first.nextCursor as string,
    })
    expect(second.entries[0]?.name).toBe("file10.dat")
    const search = await call("catalog.search", { query: `${root.name}/Paging/file2` })
    expect(search.results).toHaveLength(1)
  }, 30_000)
  it("restores older child trash together and resolves name reuse", async () => {
    const parent = await call("catalog.createFolder", { parentId: root.id, name: "Restore" })
    const child = await call("catalog.createFolder", { parentId: parent.id, name: "Child" })
    await call("catalog.trash", { id: child.id })
    await call("catalog.createFolder", { parentId: parent.id, name: "Child" })
    await call("catalog.trash", { id: parent.id })
    const bin = await call("catalog.recycleBin", {})
    expect(bin.some((e) => e.id === child.id)).toBe(false)
    await call("catalog.restore", { id: parent.id })
    const listing = await call("catalog.list", { parentId: parent.id })
    expect(listing.entries.map((e) => e.name)).toEqual(["Child", "Child (2)"])
  })
  it("rejects finalization under trash and stale downloads", async () => {
    const dir = await call("catalog.createFolder", { parentId: root.id, name: "Hidden" })
    const { entry } = await upload(dir.id, "first.dat")
    const bytes = new Uint8Array([4])
    const ticket = await call("upload.begin", {
      parentId: dir.id,
      relativePath: "late.dat",
      size: 1,
      mimeType: "application/octet-stream",
      checksumSha256: createHash("sha256").update(bytes).digest("base64"),
      modifiedAt: new Date().toISOString(),
    })
    await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: bytes })
    await call("catalog.trash", { id: dir.id })
    await expect(call("upload.finalize", { uploadId: ticket.uploadId })).rejects.toBeDefined()
    await expect(call("download.file", { id: entry.id })).rejects.toBeDefined()
    await call("catalog.deletePermanently", { id: dir.id })
    await expect(call("catalog.restore", { id: dir.id })).rejects.toBeDefined()
  })
  it("consumes a valid PIN once across concurrent verification", async () => {
    const id = randomUUID()
    const code = "123456"
    const hash = createHmac("sha256", "local-session-secret").update(`${id}:${code}`).digest("hex")
    await localSql(
      "INSERT INTO auth_pins(id,email,codeHash,expiresAt,createdAt) VALUES(?,?,?,?,?)",
      [id, "owner@example.test", hash, "2099-01-01T00:00:00Z", new Date().toISOString()],
    )
    const results = await Promise.allSettled([
      call("auth.verifyPin", { email: "owner@example.test", code, client: "web" }),
      call("auth.verifyPin", { email: "owner@example.test", code, client: "desktop" }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  })
  it("batches bulk actions with covered IDs, missing items and collision naming", async () => {
    const parent = await call("catalog.createFolder", { parentId: root.id, name: "Bulk" })
    const a = await upload(parent.id, "one.dat")
    const b = await upload(parent.id, "two.dat")
    const absent = randomUUID()
    const trashed = await call("catalog.bulk", {
      ids: [parent.id, a.entry.id, absent],
      action: "trash",
    })
    expect([...trashed.succeeded].sort()).toEqual([parent.id, a.entry.id].sort())
    expect(trashed.failed.map((e) => e.id)).toEqual([absent])
    await call("catalog.createFolder", { parentId: root.id, name: "Bulk" })
    const restored = await call("catalog.bulk", { ids: [parent.id, a.entry.id], action: "restore" })
    expect(restored.failed).toHaveLength(0)
    const listing = await call("catalog.list", { parentId: root.id })
    expect(listing.entries.find((e) => e.id === parent.id)?.name).toBe("Bulk (2)")
    const destination = await call("catalog.createFolder", {
      parentId: root.id,
      name: "Bulk destination",
    })
    await upload(destination.id, "one.dat")
    const moved = await call("catalog.bulk", {
      ids: [a.entry.id, b.entry.id],
      action: "move",
      parentId: destination.id,
    })
    expect(moved.succeeded).toHaveLength(2)
    const files = await call("catalog.list", { parentId: destination.id })
    expect(files.entries.map((e) => e.name)).toEqual(["one (2).dat", "one.dat", "two.dat"])
    await call("catalog.bulk", { ids: [destination.id], action: "trash" })
    const removed = await call("catalog.bulk", { ids: [destination.id], action: "delete" })
    expect(removed.failed).toHaveLength(0)
    await expect(call("catalog.restore", { id: destination.id })).rejects.toBeDefined()
  })
  it("builds background ZIPs with Unicode, empty folders, reuse and missing-input failure", async () => {
    const dir = await call("catalog.createFolder", { parentId: root.id, name: "ZIP 日本語" })
    await call("catalog.createFolder", { parentId: dir.id, name: "Empty" })
    const file = await upload(dir.id, "é日本語.dat", new Uint8Array([7, 8, 9]))
    const archive = await call("download.archive", { ids: [dir.id] })
    let status = archive
    const deadline = Date.now() + 30000
    while (status.status !== "completed" && status.status !== "failed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      status = await call("download.status", { id: archive.id })
    }
    expect(status.status).toBe("completed")
    expect(status.processed).toBe(1)
    const bytes = new Uint8Array(await (await fetch(status.url as string)).arrayBuffer())
    const workspace = await mkdtemp(join(tmpdir(), "cloudsync-zip-"))
    try {
      const path = join(workspace, "archive.zip")
      await writeFile(path, bytes)
      const { stdout } = await promisify(execFile)("python3", [
        "-c",
        "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(z.namelist(),ensure_ascii=False)); assert z.read('ZIP 日本語/é日本語.dat')==bytes([7,8,9])",
        path,
      ])
      expect(JSON.parse(stdout)).toContain("ZIP 日本語/Empty/")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
    const reuse = await call("download.archive", { ids: [dir.id] })
    expect(reuse.id).toBe(archive.id)
    await call("catalog.trash", { id: file.entry.id })
    await expect(call("download.status", { id: archive.id })).rejects.toBeDefined()
    await call("catalog.restore", { id: file.entry.id })
    const hidden = await call("catalog.createFolder", { parentId: root.id, name: "Broken ZIP" })
    const missing = await upload(hidden.id, "missing.dat")
    const ticket = await call("download.file", { id: missing.entry.id })
    const objectKey = new URL(ticket.url).pathname.replace("/cloudsync-local/", "")
    await fetch(`http://127.0.0.1:54332/cloudsync-local/${objectKey}`, { method: "DELETE" })
    const broken = await call("download.archive", { ids: [hidden.id] })
    let failed = broken
    while (failed.status !== "failed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      failed = await call("download.status", { id: broken.id })
    }
    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("missing.dat")
    expect(failed.url).toBeNull()
    expect(file.entry.kind).toBe("file")
  }, 40000)
})
