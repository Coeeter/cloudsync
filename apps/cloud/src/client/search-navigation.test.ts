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

it("keeps the search during folder preloading and clears it on navigation", async () => {
  const root = createRootRoute()
  // Bun runs on the server; enable this route's loader to exercise its browser navigation flow.
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreloadStaleTime: 0,
  })
  await router.load()
  registry.set(searchQueryAtom, "Signal")
  const search = { folder: "00000000-0000-0000-0000-000000000001", recycle: undefined }
  await router.preloadRoute({ to: "/", search })
  expect(registry.get(searchQueryAtom)).toBe("Signal")
  expect(router.state.location.href).toBe("/")
  await router.navigate({ to: "/", search })
  await router.load()
  expect(registry.get(searchQueryAtom)).toBe("")
})
