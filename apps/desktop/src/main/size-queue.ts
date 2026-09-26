/** Min-heap of paths by size; stale entries are skipped when their size no longer matches. */
export class SizeQueue {
  private readonly heap: Array<{ readonly path: string; readonly size: number }> = []
  private readonly sizes = new Map<string, number>()

  get size() {
    return this.sizes.size
  }

  set(path: string, size: number) {
    this.sizes.set(path, size)
    this.heap.push({ path, size })
    let index = this.heap.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if ((this.heap[parent] as { size: number }).size <= size) break
      ;[this.heap[parent], this.heap[index]] = [
        this.heap[index] as { path: string; size: number },
        this.heap[parent] as { path: string; size: number },
      ]
      index = parent
    }
  }

  /** Removes and returns the smallest queued path that is not excluded. */
  take(
    excluded: ReadonlySet<string>,
  ): { readonly path: string; readonly size: number } | undefined {
    const deferred: Array<{ readonly path: string; readonly size: number }> = []
    let found: { readonly path: string; readonly size: number } | undefined
    while (this.heap.length > 0) {
      const top = this.pop()
      if (this.sizes.get(top.path) !== top.size) continue
      if (excluded.has(top.path)) {
        deferred.push(top)
        continue
      }
      this.sizes.delete(top.path)
      found = top
      break
    }
    for (const entry of deferred) this.set(entry.path, entry.size)
    return found
  }

  clear() {
    this.heap.length = 0
    this.sizes.clear()
  }

  private pop() {
    const top = this.heap[0] as { path: string; size: number }
    const last = this.heap.pop() as { path: string; size: number }
    if (this.heap.length > 0) {
      this.heap[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (
          left < this.heap.length &&
          (this.heap[left]?.size ?? 0) < (this.heap[smallest]?.size ?? 0)
        )
          smallest = left
        if (
          right < this.heap.length &&
          (this.heap[right]?.size ?? 0) < (this.heap[smallest]?.size ?? 0)
        )
          smallest = right
        if (smallest === index) break
        ;[this.heap[smallest], this.heap[index]] = [
          this.heap[index] as { path: string; size: number },
          this.heap[smallest] as { path: string; size: number },
        ]
        index = smallest
      }
    }
    return top
  }
}
