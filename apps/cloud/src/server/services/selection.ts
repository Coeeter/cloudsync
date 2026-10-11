import type { CloudSyncDatabase } from "@cloudsync/db"
import { schema } from "@cloudsync/db"
import { CloudSyncError } from "@cloudsync/domain"
import { inArray, sql } from "drizzle-orm"

type Transaction = Parameters<Parameters<CloudSyncDatabase["transaction"]>[0]>[0]
type Db = CloudSyncDatabase | Transaction

export async function searchPaths(db: Db, query: string, limit?: number) {
  const match = `%${query.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
  const result = await db.execute(sql`
    with recursive catalog_paths as (
      select id, parent_id, name, name::text as path
      from entries where parent_id is null and deleted_at is null
      union all
      select child.id, child.parent_id, child.name, catalog_paths.path || '/' || child.name
      from entries child join catalog_paths on child.parent_id = catalog_paths.id
      where child.deleted_at is null
    )
    select id, path from catalog_paths
    where name ilike ${match} escape '\\' or path ilike ${match} escape '\\'
    order by path collate "natural", id
    ${limit === undefined ? sql`` : sql`limit ${limit}`}
  `)
  return Array.from(result as Iterable<{ id: string; path: string }>)
}

export async function selectionRoots(db: Db, requested: ReadonlyArray<string>) {
  const ids = [...new Set(requested)]
  if (
    !ids.length ||
    ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  ) {
    throw new CloudSyncError({ code: "INVALID_INPUT", message: "Select at least one valid item" })
  }
  const rows = await db.select().from(schema.entries).where(inArray(schema.entries.id, ids))
  const result = await db.execute(sql`
    with recursive ancestors as (
      select id as selected_id, id, parent_id, name from entries where ${inArray(schema.entries.id, ids)}
      union all
      select ancestors.selected_id, parent.id, parent.parent_id, parent.name
      from ancestors join entries parent on parent.id = ancestors.parent_id
    ) select * from ancestors
  `)
  const ancestors = Array.from(
    result as Iterable<{ selected_id: string; id: string; parent_id: string | null; name: string }>,
  )
  const parents = new Map(ancestors.map((row) => [row.id, row]))
  const selected = new Set(ids)
  const rootFor = (id: string) => {
    let root = id
    let parent = parents.get(id)?.parent_id
    while (parent) {
      if (selected.has(parent)) root = parent
      parent = parents.get(parent)?.parent_id
    }
    return root
  }
  const coveredByRoot = new Map<string, string[]>()
  for (const id of ids) {
    const root = rootFor(id)
    const covered = coveredByRoot.get(root) ?? []
    covered.push(id)
    coveredByRoot.set(root, covered)
  }
  const roots = rows
    .filter((row) => rootFor(row.id) === row.id)
    .map((row) => {
      const names = [row.name]
      let parent = parents.get(row.id)?.parent_id
      while (parent) {
        const entry = parents.get(parent)
        if (!entry) break
        names.unshift(entry.name)
        parent = entry.parent_id
      }
      return { row, path: names.join("/"), covered: coveredByRoot.get(row.id) ?? [] }
    })
  return { roots, missing: ids.filter((id) => !parents.has(id)) }
}
