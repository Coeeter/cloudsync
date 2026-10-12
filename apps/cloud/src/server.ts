import handler, { createServerEntry } from "@tanstack/react-start/server-entry"
import { maintenance } from "./server/maintenance"
import { ServicesLive } from "./server/layers"
import { Context, Effect } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RoutesLive } from "./server/layers"

// The RPC client appends a slash. Handle it directly: redirecting a large streaming POST
// causes Wrangler's proxy to lose the request body.
const rpcWebHandler = HttpRouter.toWebHandler(RoutesLive, { disableLogger: true })

const entry = createServerEntry({
  fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/, "")

    if (
      path === "/rpc" ||
      path === "/auth/establish" ||
      path === "/auth/logout" ||
      path === "/health" ||
      path === "/internal/zip"
    ) {
      if (url.pathname !== path) {
        url.pathname = path
        request = new Request(url, request)
      }
      return rpcWebHandler.handler(request, Context.empty())
    }

    return handler.fetch(request)
  },
})

export default {
  ...entry,
  scheduled(
    _controller: unknown,
    _env: unknown,
    context: { waitUntil: (promise: Promise<unknown>) => void },
  ) {
    context.waitUntil(Effect.runPromise(maintenance.pipe(Effect.provide(ServicesLive))))
  },
}
