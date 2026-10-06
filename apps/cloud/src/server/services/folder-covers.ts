import { type CloudSyncDatabase, schema } from "@cloudsync/db"
import { sql } from "drizzle-orm"

type Transaction = Parameters<Parameters<CloudSyncDatabase["transaction"]>[0]>[0]

/** Prefer direct covers, then the nearest image in natural path order. */
export async function folderCovers(
  db: CloudSyncDatabase | Transaction,
  directoryIds: ReadonlyArray<string>,
): Promise<Array<{ parentId: string; thumbnailKey: string }>> {
  if (directoryIds.length === 0) return []
  // Traverse directories only, and stop a branch as soon as it has a cover. Each
  // image lookup uses the parent index; originals and preview objects stay in storage.
  // Visibility follows the requested root, including inside the Recycle Bin.
  return db.execute<{ parentId: string; thumbnailKey: string }>(sql`
    with recursive covers as (
      select root.id as root_id, root.id, 0 as depth,
        array[]::text[] as names, array[root.id] as ids,
        root.deleted_at, root.trash_root_id, image.thumbnail_key
      from ${schema.entries} root
      left join lateral (
        select child.thumbnail_key
        from ${schema.entries} child
        where child.parent_id = root.id and child.kind = 'file'
          and child.thumbnail_key is not null
          and case when root.deleted_at is null then child.deleted_at is null
            else child.deleted_at is not null and child.trash_root_id = root.trash_root_id end
        order by child.name collate "natural", child.id
        limit 1
      ) image on true
      where root.id in (${sql.join(
        directoryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        and root.kind = 'directory'
      union all
      select walk.root_id, folder.id, walk.depth + 1,
        walk.names || folder.name, walk.ids || folder.id,
        walk.deleted_at, walk.trash_root_id, image.thumbnail_key
      from covers walk
      join ${schema.entries} folder on folder.parent_id = walk.id
        and folder.kind = 'directory'
        and not folder.id = any(walk.ids)
        and case when walk.deleted_at is null then folder.deleted_at is null
          else folder.deleted_at is not null and folder.trash_root_id = walk.trash_root_id end
      left join lateral (
        select child.thumbnail_key
        from ${schema.entries} child
        where child.parent_id = folder.id and child.kind = 'file'
          and child.mime_type like 'image/%' and child.thumbnail_key is not null
          and case when walk.deleted_at is null then child.deleted_at is null
            else child.deleted_at is not null and child.trash_root_id = walk.trash_root_id end
        order by child.name collate "natural", child.id
        limit 1
      ) image on true
      where walk.thumbnail_key is null
    )
    select distinct on (root_id) root_id as "parentId", thumbnail_key as "thumbnailKey"
    from covers
    where thumbnail_key is not null
    order by root_id, depth, names collate "natural", ids
  `)
}
