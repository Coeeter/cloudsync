import { describe, expect, test } from "bun:test"
import { SizeQueue } from "./size-queue"

const drain = (queue: SizeQueue, excluded: ReadonlySet<string> = new Set()) => {
  const order: Array<string> = []
  for (let next = queue.take(excluded); next; next = queue.take(excluded)) order.push(next.path)
  return order
}

describe("SizeQueue", () => {
  test("yields smallest files first", () => {
    const queue = new SizeQueue()
    for (const [path, size] of [
      ["c", 30],
      ["a", 10],
      ["d", 40],
      ["b", 20],
    ] as const)
      queue.set(path, size)
    expect(drain(queue)).toEqual(["a", "b", "c", "d"])
    expect(queue.size).toBe(0)
  })

  test("re-queueing a path uses its latest size once", () => {
    const queue = new SizeQueue()
    queue.set("grew", 1)
    queue.set("other", 5)
    queue.set("grew", 100)
    expect(queue.size).toBe(2)
    expect(drain(queue)).toEqual(["other", "grew"])
  })

  test("skips excluded paths without losing them", () => {
    const queue = new SizeQueue()
    queue.set("busy", 1)
    queue.set("free", 2)
    expect(queue.take(new Set(["busy"]))?.path).toBe("free")
    expect(queue.take(new Set())?.path).toBe("busy")
  })
})
