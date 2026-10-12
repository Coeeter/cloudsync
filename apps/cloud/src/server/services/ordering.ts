import { Effect, Schema } from "effect"
import { invalidInput } from "../errors"

// Mirrors PostgreSQL's deterministic ICU collation `und-u-kn-ks-level2`: numeric, case-insensitive,
// accent-sensitive, with remaining ties broken by UTF-8 bytes and then the UUID.
const collator = new Intl.Collator("und", { numeric: true, sensitivity: "accent" })

export interface Sortable {
  readonly id: string
  readonly kind: "file" | "directory"
  readonly name: string
}

export const kindRank = (kind: Sortable["kind"]): 0 | 1 => (kind === "directory" ? 0 : 1)

export function compareNames(left: string, right: string): number {
  return collator.compare(left, right) || Buffer.compare(Buffer.from(left), Buffer.from(right))
}

export function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareEntries(left: Sortable, right: Sortable): number {
  return (
    kindRank(left.kind) - kindRank(right.kind) ||
    compareNames(left.name, right.name) ||
    compareIds(left.id, right.id)
  )
}

export function comparePaths(
  left: { readonly path: string; readonly id: string },
  right: { readonly path: string; readonly id: string },
): number {
  return compareNames(left.path, right.path) || compareIds(left.id, right.id)
}

const CursorSchema = Schema.Tuple([Schema.Literals([0, 1]), Schema.String, Schema.String])

export interface Cursor {
  readonly rank: 0 | 1
  readonly name: string
  readonly id: string
}

export function encodeCursor(entry: Sortable): string {
  return Buffer.from(JSON.stringify([kindRank(entry.kind), entry.name, entry.id]), "utf8").toString(
    "base64url",
  )
}

export const decodeCursor = (cursor: string) =>
  Effect.try({
    try: () => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    catch: () => invalidInput("Invalid page cursor"),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(CursorSchema)(value).pipe(
        Effect.mapError(() => invalidInput("Invalid page cursor")),
      ),
    ),
    Effect.map(([rank, name, id]): Cursor => ({ rank, name, id })),
  )

export function isAfterCursor(entry: Sortable, cursor: Cursor): boolean {
  return (
    (kindRank(entry.kind) - cursor.rank ||
      compareNames(entry.name, cursor.name) ||
      compareIds(entry.id, cursor.id)) > 0
  )
}

/** Sorts in memory and applies the existing `[rank, name, id]` keyset cursor. */
export function pageEntries<A extends Sortable>(
  entries: ReadonlyArray<A>,
  limit: number,
  cursor: Cursor | null,
): { readonly page: ReadonlyArray<A>; readonly nextCursor: string | null } {
  const sorted = [...entries].sort(compareEntries)
  const remaining = cursor ? sorted.filter((entry) => isAfterCursor(entry, cursor)) : sorted
  const page = remaining.slice(0, limit)
  const last = page.at(-1)
  return { page, nextCursor: remaining.length > limit && last ? encodeCursor(last) : null }
}
