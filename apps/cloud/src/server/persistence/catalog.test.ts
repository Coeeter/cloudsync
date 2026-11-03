import { afterEach, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { Sqlite, type SqlValue } from "@cloudsync/db"
import { CatalogStore } from "./catalog"

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = new Database(":memory:")
  databases.push(db)
  db.exec(
    readFileSync(
      new URL("../../../../../packages/db/migrations/0001_catalog.sql", import.meta.url),
      "utf8",
    ),
  )
  const queries: { sql: string; rows: number }[] = []
  class LocalSqlite extends Sqlite {
    override async all<A>(sql: string, ...values: SqlValue[]): Promise<A[]> {
      const rows = db.query(sql).all(...values) as A[]
      queries.push({ sql, rows: rows.length })
      return rows
    }
    override async first<A>(sql: string, ...values: SqlValue[]): Promise<A | null> {
      return db.query(sql).get(...values) as A | null
    }
  }
  const store = new CatalogStore(new LocalSqlite(null as never))
  const add = (id: string, parentId: string | null, name: string, kind = "directory") => {
    db.query(
      "INSERT INTO entries(id,parentId,name,normalizedName,kind,createdAt,updatedAt) VALUES(?,?,?,?,?,'now','now')",
    ).run(id, parentId, name, name.toLowerCase(), kind)
  }
  return { store, add, db, queries }
}

it("collapses matching folders before the result limit can hide other matches", async () => {
  const { store, add } = fixture()
  add("album", null, "Match album")
  for (let i = 0; i < 120; i++) add(`file${i}`, "album", `${i}.txt`, "file")
  add("nested", "album", "Nested")
  add("nested-file", "nested", "match.txt", "file")
  add("other", null, "Match elsewhere", "file")
  expect((await store.paths("MATCH")).map((row) => row.id)).toEqual(["album", "other"])
  expect((await store.paths("match album/Nested/match")).map((row) => row.id)).toEqual([
    "nested-file",
  ])
})

it("searches only descendants using paths relative to the scope, retaining full display paths", async () => {
  const { store, add } = fixture()
  add("a", null, "Match A")
  add("b", null, "Match B")
  add("a-file", "a", "match.txt", "file")
  add("b-file", "b", "match.txt", "file")
  add("a-other", "a", "other.txt", "file")
  expect(await store.paths("match", "a")).toEqual([{ id: "a-file", path: "Match A/match.txt" }])
  expect(await store.paths("match", "b")).toEqual([{ id: "b-file", path: "Match B/match.txt" }])
  expect(await store.paths("Match A", "a")).toEqual([])
  expect(await store.paths("  ", "a")).toEqual([])
})

it("returns only search matches from SQL and does not enumerate matching subtrees", async () => {
  const { store, add, queries } = fixture()
  add("album", null, "Album")
  for (let i = 0; i < 2000; i++) add(`f${i}`, "album", `${i}.txt`, "file")
  expect(await store.paths("album")).toEqual([{ id: "album", path: "Album" }])
  expect(queries.at(-1)?.rows).toBe(1)
  expect(await store.paths("absent", "album")).toEqual([])
  expect(queries.at(-1)?.rows).toBe(0)
})

it("preserves Unicode case matching and treats SQL wildcard characters literally", async () => {
  const { store, add } = fixture()
  add("unicode", null, "ÉTÉ_100%.txt", "file")
  expect((await store.paths("été_100%")).map((row) => row.id)).toEqual(["unicode"])
  expect(await store.paths("_200%")).toEqual([])
})

it("batches counts and stops cover traversal at the nearest matching level", async () => {
  const { store, add, db, queries } = fixture()
  add("a", null, "A")
  add("b", null, "B")
  add("a-child", "a", "Nested")
  add("a-cover", "a-child", "image2.png", "file")
  add("a-later", "a-child", "image10.png", "file")
  add("a-deep", "a-child", "Deeper")
  for (let i = 0; i < 2000; i++) add(`deep${i}`, "a-deep", `${i}.png`, "file")
  add("b-cover", "b", "direct.png", "file")
  db.run("UPDATE entries SET thumbnailKey='cover-'||id,mimeType='image/png' WHERE kind='file'")
  db.run("UPDATE entries SET thumbnailKey='directory-cover' WHERE id='a-deep'")
  const a = await store.visible("a")
  const roots = [a, await store.visible("b")]
  queries.length = 0
  await store.summary(a)
  expect(queries.reduce((sum, q) => sum + q.rows, 0)).toBeLessThan(15)
  queries.length = 0
  const summaries = await store.summaries(roots)
  expect(summaries.get("a")).toEqual({ count: 1, cover: "cover-a-cover" })
  expect(summaries.get("b")).toEqual({ count: 1, cover: "cover-b-cover" })
  expect(queries.length).toBeLessThanOrEqual(4)
  expect(queries.reduce((sum, q) => sum + q.rows, 0)).toBeLessThan(15)
})

it("keeps direct cover precedence, empty folders and trash visibility", async () => {
  const { store, add, db } = fixture()
  add("root", null, "Root")
  add("empty", null, "Empty")
  add("dir-cover", "root", "Folder")
  add("file-cover", "root", "0.png", "file")
  db.run("UPDATE entries SET thumbnailKey='directory-cover' WHERE id='dir-cover'")
  db.run("UPDATE entries SET thumbnailKey='file-cover',mimeType='image/png' WHERE id='file-cover'")
  expect(await store.summary(await store.visible("root"))).toEqual({
    count: 2,
    cover: "directory-cover",
  })
  expect(await store.summary(await store.visible("empty"))).toEqual({ count: 0, cover: null })
  db.run("UPDATE entries SET deletedAt='now',trashRootId='dir-cover' WHERE id='dir-cover'")
  expect(await store.summary(await store.visible("root"))).toEqual({
    count: 1,
    cover: "file-cover",
  })
  db.run("UPDATE entries SET deletedAt='now',trashRootId='root' WHERE id='root' OR parentId='root'")
  const trashedRoot = await store.row("root")
  if (!trashedRoot) throw new Error("Fixture root missing")
  expect(await store.summary(trashedRoot)).toEqual({ count: 2, cover: "directory-cover" })
})
