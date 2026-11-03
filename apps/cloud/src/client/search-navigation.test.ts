import { afterEach, expect, it } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { Route } from "../routes/index"
import { registry, searchQueryAtom } from "./state"

afterEach(() => registry.set(searchQueryAtom, ""))

async function makeRouter(initialEntry = "/") {
  const root = createRootRoute()
  // Run the loader in Bun; history.push below models navigation because server routers ignore navigate().
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    validateSearch: Route.options.validateSearch,
    loaderDeps: Route.options.loaderDeps,
    loader: Route.options.loader,
    ssr: true,
  })
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPreloadStaleTime: 0,
  })
  await router.load()
  return router
}

it("keeps the search during folder preloading and clears it on navigation", async () => {
  const router = await makeRouter()
  registry.set(searchQueryAtom, "Signal")
  const search = { folder: "00000000-0000-0000-0000-000000000001", recycle: undefined }
  await router.preloadRoute({ to: "/", search })
  expect(registry.get(searchQueryAtom)).toBe("Signal")
  expect(router.state.location.href).toBe("/")
  router.history.push(router.buildLocation({ to: "/", search }).href)
  await router.load()
  expect(registry.get(searchQueryAtom)).toBe("")
})

it("preserves the query when switching to global search, then clears it when opening a folder", async () => {
  const router = await makeRouter("/?folder=00000000-0000-0000-0000-000000000001")
  registry.set(searchQueryAtom, "Signal")
  const search = { folder: undefined, recycle: undefined, q: "Signal" }
  await router.preloadRoute({ to: "/", search })
  expect(registry.get(searchQueryAtom)).toBe("Signal")
  router.history.push(router.buildLocation({ to: "/", search }).href)
  await router.load()
  expect(router.state.location.search.folder).toBeUndefined()
  expect(registry.get(searchQueryAtom)).toBe("Signal")
  router.history.push(
    router.buildLocation({
      to: "/",
      search: { folder: "00000000-0000-0000-0000-000000000002", recycle: undefined },
    }).href,
  )
  await router.load()
  expect(registry.get(searchQueryAtom)).toBe("")
})
