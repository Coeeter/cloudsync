import { randomUUID } from "node:crypto"
import { nextAvailableName, sanitizeRelativePath } from "@cloudsync/core"
import type { Sqlite, Statement } from "@cloudsync/db"
import { CloudSyncError, type BulkAction } from "@cloudsync/domain"
import { invalidInput, notFound } from "../errors"
import { compareEntries, compareNames } from "../services/ordering"

export interface EntryRow {
  id: string
  parentId: string | null
  name: string
  normalizedName: string
  kind: "file" | "directory"
  objectKey: string | null
  mimeType: string | null
  size: number
  checksumSha256: string | null
  modifiedAt: string | null
  thumbnailKey: string | null
  previewKey: string | null
  previewError: string | null
  isAnimated: number | null
  deletedAt: string | null
  originalParentId: string | null
  trashRootId: string | null
  deleting: number
  createdAt: string
  updatedAt: string
}
type AncestorRow = Pick<EntryRow, "id" | "parentId" | "name" | "kind" | "deletedAt" | "deleting">
type SelectionRow = AncestorRow &
  Pick<EntryRow, "trashRootId" | "originalParentId" | "objectKey" | "size">
export const now = () => new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z")
export const normalize = (name: string) => name.normalize("NFC").toLocaleLowerCase("en")
export function validName(name: string): string {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name))
    throw invalidInput("That name cannot be used")
  return name.normalize("NFC")
}
export const SUBTREE =
  "WITH RECURSIVE tree(id) AS (SELECT id FROM entries WHERE id=? UNION SELECT e.id FROM entries e JOIN tree t ON e.parentId=t.id)"
export const PATHS = `WITH RECURSIVE paths AS (
 SELECT e.*,e.name AS path FROM entries e WHERE parentId IS NULL AND deletedAt IS NULL AND deleting=0
 UNION ALL SELECT e.*,p.path||'/'||e.name FROM entries e JOIN paths p ON e.parentId=p.id WHERE e.deletedAt IS NULL AND e.deleting=0
)`

export async function retry<A>(operation: () => Promise<A>): Promise<A> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof CloudSyncError) throw error
      if (!/UNIQUE constraint|CHECK constraint|invalid parent|cycle/.test(String(error)))
        throw error
      if (String(error).includes("cycle"))
        throw invalidInput("A folder cannot be moved inside itself")
      if (attempt >= 15)
        throw new CloudSyncError({ code: "CONFLICT", message: "The folder changed; try again" })
      await new Promise((resolve) => setTimeout(resolve, Math.min(80, 5 * (attempt + 1))))
    }
  }
}

export class CatalogStore {
  constructor(readonly db: Sqlite) {}
  row(id: string) {
    return this.db.first<EntryRow>("SELECT * FROM entries WHERE id=?", id)
  }
  async chain(id: string): Promise<EntryRow[]> {
    const rows = await this.db.all<EntryRow & { depth: number }>(
      `WITH RECURSIVE chain AS (
    SELECT e.*,0 AS depth FROM entries e WHERE id=? UNION ALL
    SELECT e.*,c.depth+1 FROM entries e JOIN chain c ON e.id=c.parentId WHERE c.depth<1000
  ) SELECT * FROM chain ORDER BY depth`,
      id,
    )
    if (rows.at(-1)?.parentId) throw invalidInput("Invalid or excessively deep hierarchy")
    return rows
  }
  async visible(id: string): Promise<EntryRow> {
    const chain = await this.chain(id)
    if (!chain[0] || chain.some((e) => e.deletedAt || e.deleting)) throw notFound()
    return chain[0]
  }
  async directory(id: string | null) {
    if (!id) return
    if ((await this.visible(id)).kind !== "directory")
      throw notFound("Destination folder not found")
  }
  async children(id: string | null, trashed = false): Promise<EntryRow[]> {
    return this.db.all<EntryRow>(
      `SELECT * FROM entries WHERE parentId IS ? AND deleting=0 ${trashed ? "" : "AND deletedAt IS NULL"}`,
      id,
    )
  }
  async name(parentId: string | null, requested: string, excludeId = "") {
    const siblings = await this.db.all<{ name: string }>(
      "SELECT name FROM entries WHERE parentId IS ? AND deletedAt IS NULL AND deleting=0 AND id<>?",
      parentId,
      excludeId,
    )
    return nextAvailableName(
      validName(requested),
      siblings.map((e) => e.name),
    )
  }
  insert(row: EntryRow): Statement {
    const fields = Object.keys(row) as (keyof EntryRow)[]
    return [
      `INSERT INTO entries(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`,
      ...fields.map((f) => row[f]),
    ]
  }
  async createDirectory(
    parentId: string | null,
    requested: string,
    reuse = false,
  ): Promise<EntryRow> {
    return retry(async () => {
      const revision = await this.db.revision()
      await this.directory(parentId)
      if (reuse) {
        const existing = await this.db.first<EntryRow>(
          "SELECT * FROM entries WHERE parentId IS ? AND normalizedName=? AND deletedAt IS NULL AND deleting=0",
          parentId,
          normalize(requested),
        )
        if (existing?.kind === "directory") return existing
      }
      const name = await this.name(parentId, requested)
      const row = makeEntry({ parentId, name, kind: "directory" })
      await this.db.commit(revision, [this.insert(row)])
      return row
    })
  }
  async relocate(
    id: string,
    requestedName?: string,
    destination?: string | null,
  ): Promise<EntryRow> {
    return retry(async () => {
      const revision = await this.db.revision()
      const row = await this.visible(id)
      const parentId = destination === undefined ? row.parentId : destination
      await this.directory(parentId)
      if (parentId && (await this.chain(parentId)).some((e) => e.id === id))
        throw invalidInput("A folder cannot be moved inside itself")
      const name = await this.name(parentId, requestedName ?? row.name, id)
      const updatedAt = now()
      await this.db.commit(revision, [
        [
          "UPDATE entries SET parentId=?,name=?,normalizedName=?,updatedAt=? WHERE id=?",
          parentId,
          name,
          normalize(name),
          updatedAt,
          id,
        ],
      ])
      return { ...row, parentId, name, normalizedName: normalize(name), updatedAt }
    })
  }
  async trash(id: string) {
    await retry(async () => {
      const revision = await this.db.revision()
      const row = await this.visible(id)
      const date = now()
      await this.db.commit(revision, [
        ["UPDATE entries SET originalParentId=parentId WHERE id=?", id],
        [
          `${SUBTREE} UPDATE entries SET deletedAt=?,trashRootId=?,updatedAt=? WHERE id IN (SELECT id FROM tree)`,
          id,
          date,
          id,
          date,
        ],
      ])
      return row
    })
  }
  async restore(id: string): Promise<EntryRow> {
    return retry(async () => {
      const revision = await this.db.revision()
      const root = await this.row(id)
      if (!root?.deletedAt || root.trashRootId !== id || root.deleting)
        throw notFound("Recycle Bin item not found")
      let parentId = root.originalParentId
      if (parentId) {
        try {
          await this.directory(parentId)
        } catch {
          parentId = null
        }
      }
      const rows = await this.db.all<EntryRow>("SELECT * FROM entries WHERE trashRootId=?", id)
      const rootName = await this.name(parentId, root.name, id)
      const names = new Map<string, Set<string>>()
      const changes: Statement[] = []
      for (const row of [...rows].sort(compareEntries)) {
        if (row.id === id) continue
        const key = row.parentId ?? ""
        let used = names.get(key)
        if (!used) {
          used = new Set()
          names.set(key, used)
        }
        const name = nextAvailableName(row.name, used)
        used.add(name)
        if (name !== row.name)
          changes.push([
            "UPDATE entries SET name=?,normalizedName=? WHERE id=?",
            name,
            normalize(name),
            row.id,
          ])
      }
      const date = now()
      await this.db.commit(revision, [
        ...changes,
        [
          "UPDATE entries SET parentId=?,name=?,normalizedName=? WHERE id=?",
          parentId,
          rootName,
          normalize(rootName),
          id,
        ],
        [
          "UPDATE entries SET deletedAt=NULL,trashRootId=NULL,originalParentId=NULL,updatedAt=? WHERE trashRootId=?",
          date,
          id,
        ],
      ])
      return {
        ...root,
        parentId,
        name: rootName,
        deletedAt: null,
        trashRootId: null,
        updatedAt: date,
      }
    })
  }
  async markDeleting(id: string) {
    await retry(async () => {
      const revision = await this.db.revision()
      const row = await this.row(id)
      if (!row?.deletedAt || row.trashRootId !== id) throw notFound("Recycle Bin item not found")
      await this.db.commit(revision, this.deletionStatements([id]))
    })
  }
  deletionStatements(ids: readonly string[]): Statement[] {
    const statements: Statement[] = []
    for (let start = 0; start < ids.length; start += 500) {
      const batch = JSON.stringify(ids.slice(start, start + 500))
      const tree =
        "WITH RECURSIVE tree(id) AS (SELECT id FROM entries WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT e.id FROM entries e JOIN tree t ON e.parentId=t.id)"
      statements.push(
        [
          `${tree}, objects AS (
          SELECT objectKey AS key FROM entries WHERE id IN (SELECT id FROM tree) AND objectKey IS NOT NULL
          UNION ALL SELECT thumbnailKey FROM entries WHERE id IN (SELECT id FROM tree) AND thumbnailKey IS NOT NULL
          UNION ALL SELECT previewKey FROM entries WHERE id IN (SELECT id FROM tree) AND previewKey IS NOT NULL
        ), numbered AS (SELECT key,(row_number() OVER (ORDER BY key)-1)/100 AS batch FROM objects)
        INSERT INTO cleanup(id,objectKeys,createdAt) SELECT ?||'-'||batch,json_group_array(key),? FROM numbered GROUP BY batch`,
          batch,
          randomUUID(),
          now(),
        ],
        [`${tree} UPDATE entries SET deleting=1 WHERE id IN (SELECT id FROM tree)`, batch],
      )
    }
    return statements
  }
  async bulk(ids: readonly string[], action: BulkAction, destination?: string | null) {
    return retry(async () => {
      const revision = await this.db.revision()
      const roots = await this.roots(ids, true)
      const found = new Set(roots.flatMap((r) => r.covered))
      const failed = ids
        .filter((id) => !found.has(id))
        .map((id) => ({ id, message: "Item no longer exists" }))
      const eligible = roots.filter((root) => {
        const valid =
          action === "restore" || action === "delete"
            ? !!root.row.deletedAt && root.row.trashRootId === root.row.id && !root.row.deleting
            : !root.chain.some((e) => e.deletedAt || e.deleting)
        if (!valid)
          failed.push(
            ...root.covered.map((id) => ({
              id,
              message: "Item is no longer available for this action",
            })),
          )
        return valid
      })
      const statements: Statement[] = []
      let succeeded = eligible.flatMap((r) => r.covered)
      if (action === "trash") {
        const date = now()
        for (let start = 0; start < eligible.length; start += 500) {
          const batch = JSON.stringify(eligible.slice(start, start + 500).map((r) => r.row.id))
          statements.push(
            [
              "UPDATE entries SET originalParentId=parentId WHERE id IN (SELECT value FROM json_each(?))",
              batch,
            ],
            [
              `WITH RECURSIVE tree(id,root) AS MATERIALIZED (
              SELECT id,id FROM entries WHERE id IN (SELECT value FROM json_each(?))
              UNION ALL SELECT e.id,t.root FROM entries e JOIN tree t ON e.parentId=t.id
            ) UPDATE entries SET deletedAt=?,trashRootId=tree.root,updatedAt=? FROM tree WHERE entries.id=tree.id`,
              batch,
              date,
              date,
            ],
          )
        }
      } else if (action === "delete")
        statements.push(...this.deletionStatements(eligible.map((r) => r.row.id)))
      else {
        const active = await this.db.all<{ id: string; parentId: string | null; name: string }>(
          "SELECT id,parentId,name FROM entries WHERE deletedAt IS NULL AND deleting=0",
        )
        const names = new Map<string, Set<string>>()
        for (const row of active) {
          const key = row.parentId ?? ""
          const used = names.get(key) ?? new Set<string>()
          used.add(normalize(row.name))
          names.set(key, used)
        }
        const claimName = (parentId: string | null, requested: string) => {
          const key = parentId ?? ""
          const used = names.get(key) ?? new Set<string>()
          names.set(key, used)
          const name = used.has(normalize(requested))
            ? nextAvailableName(requested, used)
            : requested
          used.add(normalize(name))
          return name
        }
        const changes: {
          id: string
          parentId: string | null
          name: string
          normalizedName: string
        }[] = []
        if (action === "move") {
          if (destination === undefined) throw invalidInput("Choose a destination")
          await this.directory(destination)
          const chain = destination ? await this.chain(destination) : []
          const moved = eligible.filter((root) => {
            if (chain.some((e) => e.id === root.row.id)) {
              failed.push(
                ...root.covered.map((id) => ({
                  id,
                  message: "A folder cannot be moved inside itself",
                })),
              )
              return false
            }
            return true
          })
          succeeded = moved.flatMap((r) => r.covered)
          for (const { row } of moved) {
            if (row.parentId === destination) continue
            const name = claimName(destination, row.name)
            changes.push({
              id: row.id,
              parentId: destination,
              name,
              normalizedName: normalize(name),
            })
          }
        } else {
          const directories = await this.db.all<EntryRow>(
            "SELECT id,parentId,deletedAt,deleting FROM entries WHERE kind='directory'",
          )
          const byId = new Map(directories.map((d) => [d.id, d]))
          const visible = new Map<string, boolean>()
          const parentVisible = (id: string | null): boolean => {
            if (!id) return true
            const known = visible.get(id)
            if (known !== undefined) return known
            const row = byId.get(id)
            const valid = !!row && !row.deletedAt && !row.deleting && parentVisible(row.parentId)
            visible.set(id, valid)
            return valid
          }
          const rootIds = new Set(eligible.map((r) => r.row.id))
          for (const { row } of eligible) {
            const parentId = parentVisible(row.originalParentId) ? row.originalParentId : null
            const name = claimName(parentId, row.name)
            changes.push({ id: row.id, parentId, name, normalizedName: normalize(name) })
          }
          for (let start = 0; start < eligible.length; start += 500) {
            const batch = JSON.stringify(eligible.slice(start, start + 500).map((r) => r.row.id))
            const members = await this.db.all<EntryRow>(
              "SELECT id,parentId,name,kind FROM entries WHERE trashRootId IN (SELECT value FROM json_each(?)) AND deleting=0",
              batch,
            )
            for (const row of members.sort(compareEntries)) {
              if (rootIds.has(row.id)) continue
              const name = claimName(row.parentId, row.name)
              if (name !== row.name)
                changes.push({
                  id: row.id,
                  parentId: row.parentId,
                  name,
                  normalizedName: normalize(name),
                })
            }
          }
        }
        for (let start = 0; start < changes.length; start += 500)
          statements.push([
            `WITH changes AS MATERIALIZED (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.parentId') AS parentId,json_extract(value,'$.name') AS name,json_extract(value,'$.normalizedName') AS normalizedName FROM json_each(?))
          UPDATE entries SET parentId=changes.parentId,name=changes.name,normalizedName=changes.normalizedName,updatedAt=? FROM changes WHERE entries.id=changes.id`,
            JSON.stringify(changes.slice(start, start + 500)),
            now(),
          ])
        if (action === "restore")
          for (let start = 0; start < eligible.length; start += 500)
            statements.push([
              "UPDATE entries SET deletedAt=NULL,trashRootId=NULL,originalParentId=NULL,updatedAt=? WHERE trashRootId IN (SELECT value FROM json_each(?)) AND deleting=0",
              now(),
              JSON.stringify(eligible.slice(start, start + 500).map((r) => r.row.id)),
            ])
      }
      if (statements.length) await this.db.commit(revision, statements)
      return { succeeded, failed }
    })
  }
  async summary(directory: EntryRow) {
    const children = await this.children(directory.id, !!directory.deletedAt)
    const direct = children.sort(compareEntries).find((e) => e.thumbnailKey)
    if (direct) return { count: children.length, cover: direct.thumbnailKey }
    const images = await this.db.all<{ thumbnailKey: string; path: string; depth: number }>(
      `WITH RECURSIVE tree AS (
   SELECT e.*,e.name AS path,0 AS depth FROM entries e WHERE parentId=? AND deleting=0 AND (deletedAt IS NULL OR trashRootId=?)
   UNION ALL SELECT e.*,t.path||'/'||e.name,t.depth+1 FROM entries e JOIN tree t ON e.parentId=t.id WHERE e.deleting=0 AND (e.deletedAt IS NULL OR e.trashRootId=?)
  ) SELECT thumbnailKey,path,depth FROM tree WHERE thumbnailKey IS NOT NULL AND mimeType LIKE 'image/%'`,
      directory.id,
      directory.trashRootId,
      directory.trashRootId,
    )
    images.sort((a, b) => a.depth - b.depth || compareNames(a.path, b.path))
    return { count: children.length, cover: images[0]?.thumbnailKey ?? null }
  }
  async paths(query: string) {
    const rows = await this.db.all<{ id: string; path: string }>(`WITH RECURSIVE paths AS (
      SELECT id,parentId,name,name AS path FROM entries WHERE parentId IS NULL AND deletedAt IS NULL AND deleting=0
      UNION ALL SELECT e.id,e.parentId,e.name,p.path||'/'||e.name FROM entries e JOIN paths p ON e.parentId=p.id WHERE e.deletedAt IS NULL AND e.deleting=0
    ) SELECT id,path FROM paths`)
    const needle = query.trim().toLocaleLowerCase()
    return rows
      .filter((e) => e.path.toLocaleLowerCase().includes(needle))
      .sort((a, b) => compareNames(a.path, b.path) || a.id.localeCompare(b.id))
  }
  async roots(ids: readonly string[], allowMissing = false) {
    const unique = [...new Set(ids)]
    const selected = new Set(unique)
    const rows: SelectionRow[] = []
    for (let start = 0; start < unique.length; start += 500) {
      rows.push(
        ...(await this.db.all<SelectionRow>(
          "SELECT id,parentId,name,kind,objectKey,size,deletedAt,deleting,trashRootId,originalParentId FROM entries WHERE id IN (SELECT value FROM json_each(?))",
          JSON.stringify(unique.slice(start, start + 500)),
        )),
      )
    }
    if (!allowMissing && rows.length !== unique.length)
      throw notFound("Some selected items no longer exist")
    const directories = await this.db.all<AncestorRow>(
      "SELECT id,parentId,name,kind,deletedAt,deleting FROM entries WHERE kind='directory'",
    )
    const parents = new Map(directories.map((e) => [e.id, e]))
    const roots = []
    const covered = new Map<string, string[]>()
    for (const row of rows) {
      const chain: AncestorRow[] = [row]
      const seen = new Set([row.id])
      let parentId = row.parentId
      while (parentId) {
        const parent = parents.get(parentId)
        if (!parent || seen.has(parentId)) throw invalidInput("Invalid hierarchy")
        seen.add(parentId)
        chain.push(parent)
        parentId = parent.parentId
      }
      const selectedRoot =
        chain
          .slice()
          .reverse()
          .find((e) => selected.has(e.id))?.id ?? row.id
      const group = covered.get(selectedRoot) ?? []
      group.push(row.id)
      covered.set(selectedRoot, group)
      if (selectedRoot !== row.id) continue
      roots.push({
        row,
        chain,
        path: chain
          .slice()
          .reverse()
          .map((e) => e.name)
          .join("/"),
      })
    }
    return roots.map((root) => ({ ...root, covered: covered.get(root.row.id) ?? [root.row.id] }))
  }
  async manifest(ids: readonly string[]) {
    const revision = await this.db.revision()
    const roots = await this.roots(ids)
    if (!roots.length || roots.some((r) => r.chain.some((e) => e.deletedAt || e.deleting)))
      throw notFound("Some selected items are unavailable")
    const entries: Array<{ path: string; objectKey: string | null; size: number }> = []
    const memberIds: string[] = []
    for (let start = 0; start < roots.length; start += 500) {
      const batch = roots.slice(start, start + 500)
      const prefixes = new Map(
        batch.map((r) => [r.row.id, roots.length === 1 ? "" : r.path.slice(0, -r.row.name.length)]),
      )
      const rows = await this.db.all<EntryRow & { path: string; root: string }>(
        `WITH RECURSIVE tree AS (
        SELECT e.id,e.parentId,e.name,e.kind,e.objectKey,e.size,e.name AS path,e.id AS root FROM entries e WHERE id IN (SELECT value FROM json_each(?)) AND deletedAt IS NULL AND deleting=0
        UNION ALL SELECT e.id,e.parentId,e.name,e.kind,e.objectKey,e.size,t.path||'/'||e.name,t.root FROM entries e JOIN tree t ON e.parentId=t.id WHERE e.deletedAt IS NULL AND e.deleting=0
      ) SELECT * FROM tree`,
        JSON.stringify(batch.map((r) => r.row.id)),
      )
      for (const row of rows) {
        memberIds.push(row.id)
        const path = (prefixes.get(row.root) ?? "") + row.path
        if (sanitizeRelativePath(path).join("/") !== path)
          throw invalidInput("Invalid archive path")
        if (row.kind === "file" && !row.objectKey) throw notFound("A file has no stored original")
        entries.push({
          path: path + (row.kind === "directory" ? "/" : ""),
          objectKey: row.kind === "directory" ? null : row.objectKey,
          size: row.size,
        })
      }
    }
    entries.sort((a, b) => compareNames(a.path, b.path))
    return {
      revision,
      entries,
      memberIds,
      name: roots.length === 1 ? `${roots[0]?.row.name}.zip` : "CloudSync selection.zip",
    }
  }
}
export function makeEntry(
  input: Partial<EntryRow> & Pick<EntryRow, "name" | "kind" | "parentId">,
): EntryRow {
  const date = now()
  return {
    id: randomUUID(),
    objectKey: null,
    mimeType: null,
    size: 0,
    checksumSha256: null,
    modifiedAt: null,
    thumbnailKey: null,
    previewKey: null,
    previewError: null,
    isAnimated: null,
    deletedAt: null,
    originalParentId: null,
    trashRootId: null,
    deleting: 0,
    createdAt: date,
    updatedAt: date,
    ...input,
    normalizedName: normalize(input.name),
  }
}
