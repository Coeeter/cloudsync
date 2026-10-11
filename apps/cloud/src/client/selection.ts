export function toggleSelection(
  selected: ReadonlySet<string>,
  id: string,
  ordered: ReadonlyArray<string>,
  anchor: string | null,
  range: boolean,
) {
  const next = new Set(selected)
  const first = anchor === null ? -1 : ordered.indexOf(anchor)
  const last = ordered.indexOf(id)
  const ids =
    range && first >= 0 && last >= 0
      ? ordered.slice(Math.min(first, last), Math.max(first, last) + 1)
      : [id]
  const selecting = !selected.has(id)
  for (const item of ids) {
    if (selecting) next.add(item)
    else next.delete(item)
  }
  return next
}
