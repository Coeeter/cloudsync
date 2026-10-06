import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { schema } from "@cloudsync/db"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { folderCovers } from "./folder-covers"

const connection = process.env.CLOUDSYNC_TEST_DATABASE_URL
const integration = connection ? describe : describe.skip

integration("Folder covers with real PostgreSQL", () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>> & { $client: ReturnType<typeof postgres> }
  let ids: string[] = []

  beforeAll(async () => {
    if (
      !connection ||
      new URL(connection).hostname !== "127.0.0.1" ||
      new URL(connection).pathname !== "/cloudsync_worker_test"
    )
      throw new Error("Use the disposable local cloudsync_worker_test database")
    client = postgres(connection, { max: 1 })
    db = Object.assign(drizzle(client, { schema }), { $client: client })
    await migrate(db, {
      migrationsFolder: resolve(import.meta.dirname, "../../../../../packages/db/drizzle"),
    })
  })

  afterEach(async () => {
    if (ids.length) await db.delete(schema.entries).where(inArray(schema.entries.id, ids))
    ids = []
  })

  afterAll(async () => {
    await client?.end()
  })

  async function entry(
    name: string,
    parentId: string | null = null,
    options: Partial<typeof schema.entries.$inferInsert> = {},
  ) {
    const id = crypto.randomUUID()
    ids.push(id)
    await db.insert(schema.entries).values({
      id,
      name,
      normalizedName: name.toLowerCase(),
      parentId,
      kind: "directory",
      ...options,
    })
    return id
  }

  const image = (name: string, parentId: string, options = {}) =>
    entry(name, parentId, {
      kind: "file",
      mimeType: "image/png",
      thumbnailKey: name,
      ...options,
    })

  it("keeps direct covers and finds naturally sorted images at the nearest depth in one batch", async () => {
    const direct = await entry("direct")
    await image("image10.png", direct)
    await image("image2.png", direct)
    const directChild = await entry("child", direct)
    await image("earlier.png", directChild)

    const nested = await entry("nested")
    const folder10 = await entry("set10", nested)
    const folder2 = await entry("set2", nested)
    const deep = await entry("deep", folder2)
    await image("deep.png", deep)
    await image("shallow10.png", folder10)
    const shallow2 = await image("shallow2.png", folder2)
    await image("shallow1.png", folder2, { thumbnailKey: null })
    const empty = await entry("empty")
    await entry("more empty folders", empty)

    const covers = await folderCovers(db, [direct, nested, empty])
    expect(covers).toEqual(
      expect.arrayContaining([
        { parentId: direct, thumbnailKey: "image2.png" },
        { parentId: nested, thumbnailKey: "shallow2.png" },
      ]),
    )
    expect(covers.length).toBe(2)
    expect(await folderCovers(db, [])).toEqual([])

    // Depth wins over an earlier path; renaming and deleting candidates update the choice.
    await db.update(schema.entries).set({ name: "set20" }).where(eq(schema.entries.id, folder2))
    expect(await folderCovers(db, [nested])).toEqual([
      { parentId: nested, thumbnailKey: "shallow10.png" },
    ])
    await db.update(schema.entries).set({ name: "set1" }).where(eq(schema.entries.id, folder2))
    await db.delete(schema.entries).where(eq(schema.entries.id, shallow2))
    expect(await folderCovers(db, [nested])).toEqual([
      { parentId: nested, thumbnailKey: "shallow10.png" },
    ])
  })

  it("ignores trashed branches and non-image fallback previews; follows moves and new previews immediately", async () => {
    const root = await entry("root")
    const other = await entry("other")
    const hidden = await entry("a hidden", root, { deletedAt: new Date() })
    await image("hidden.png", hidden)
    const child = await entry("child", root)
    await entry("movie.mp4", child, {
      kind: "file",
      mimeType: "video/mp4",
      thumbnailKey: "video",
    })
    const pending = await image("pending.png", child, { thumbnailKey: null })
    expect(await folderCovers(db, [root])).toEqual([])
    await db
      .update(schema.entries)
      .set({ thumbnailKey: "ready" })
      .where(eq(schema.entries.id, pending))
    expect(await folderCovers(db, [root])).toEqual([{ parentId: root, thumbnailKey: "ready" }])
    await db.update(schema.entries).set({ parentId: other }).where(eq(schema.entries.id, child))
    expect(await folderCovers(db, [root, other])).toEqual([
      { parentId: other, thumbnailKey: "ready" },
    ])
  })

  it("uses only the same trash subtree at every depth and terminates corrupt cycles", async () => {
    const deletedAt = new Date()
    const root = await entry("trash", null, { deletedAt })
    await db.update(schema.entries).set({ trashRootId: root }).where(eq(schema.entries.id, root))
    const child = await entry("child", root, { deletedAt, trashRootId: root })
    const nested = await entry("nested", child, { deletedAt, trashRootId: root })
    await image("foreign.png", nested, { deletedAt, trashRootId: crypto.randomUUID() })
    await image("active.png", nested)
    expect(await folderCovers(db, [root, child])).toEqual([])
    await image("same-trash.png", nested, { deletedAt, trashRootId: root })
    expect(await folderCovers(db, [root, child])).toEqual(
      expect.arrayContaining([
        { parentId: root, thumbnailKey: "same-trash.png" },
        { parentId: child, thumbnailKey: "same-trash.png" },
      ]),
    )
    const cycle = await entry("cycle")
    const cycleChild = await entry("cycle child", cycle)
    await db
      .update(schema.entries)
      .set({ parentId: cycleChild })
      .where(eq(schema.entries.id, cycle))
    expect(await folderCovers(db, [cycle])).toEqual([])
  })
})
