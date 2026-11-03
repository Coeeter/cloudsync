import { afterEach, expect, it, spyOn } from "bun:test"
import { AsyncResult } from "effect/unstable/reactivity"
import { folderAtom, registry, visit } from "./state"

const originalFetch = globalThis.fetch
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
afterEach(() => {
  registry.reset()
  globalThis.fetch = originalFetch
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation)
  else Reflect.deleteProperty(globalThis, "location")
})

it("prepares the destination while session validation is pending and shares it through navigation", async () => {
  registry.reset()
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://localhost/"),
  })
  const session = Promise.withResolvers<void>()
  const listingStarted = Promise.withResolvers<boolean>()
  const listingReady = Promise.withResolvers<void>()
  const requests: (string | null)[] = []
  const fakeFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes("/auth/viewer")) return Response.json({ ok: true })
    const request = JSON.parse(
      input instanceof Request ? await input.text() : String(init?.body),
    ) as { id: number; tag: string; payload: { parentId: string | null } }
    let value: unknown
    if (request.tag === "auth.session") {
      await session.promise
      value = { email: "owner@localhost", expiresAt: "9999-12-31T00:00:00.000Z" }
    } else {
      requests.push(request.payload.parentId)
      listingStarted.resolve(true)
      if (request.payload.parentId === "A") await listingReady.promise
      value = {
        directory: null,
        breadcrumbs: [
          { id: request.payload.parentId, name: request.payload.parentId ?? "CloudSync" },
        ],
        entries: [],
        nextCursor: null,
      }
    }
    return Response.json([
      { _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } },
    ])
  }
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fakeFetch as typeof fetch)
  const preparing = visit("A", false)
  let secondVisit: Promise<void> | undefined
  try {
    const overlaps = await Promise.race([
      listingStarted.promise,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ])
    expect(overlaps).toBe(true)
    secondVisit = visit("A", false)
  } finally {
    session.resolve()
    listingReady.resolve()
    await preparing
    await secondVisit
  }
  expect(AsyncResult.isSuccess(registry.get(folderAtom("A")))).toBe(true)
  await visit("A", false)
  expect(requests).toEqual(["A"])
  await visit("B", false)
  expect(requests).toEqual(["A", "B"])
  const b = registry.get(folderAtom("B"))
  expect(AsyncResult.isSuccess(b) && b.value.items[0]?.breadcrumbs[0]?.id).toBe("B")
  await visit("A", false)
  expect(requests).toEqual(["A", "B"])
  const now = Date.now()
  const clock = spyOn(Date, "now").mockReturnValue(now + 6000)
  try {
    await visit("A", false)
    expect(requests).toEqual(["A", "B", "A"])
  } finally {
    clock.mockRestore()
    fetchSpy.mockRestore()
  }
})
