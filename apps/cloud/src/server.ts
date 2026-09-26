import handler, { createServerEntry } from "@tanstack/react-start/server-entry"
import { Context } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RoutesLive } from "./server/layers"

// Built here rather than in layers.ts so the worker can import shared layers without
// constructing a second web runtime and database pool.
const rpcWebHandler = HttpRouter.toWebHandler(RoutesLive, { disableLogger: true })

export default createServerEntry({
  fetch(request) {
    const path = new URL(request.url).pathname

    if (
      path === "/rpc" ||
      path === "/auth/establish" ||
      path === "/auth/logout" ||
      path === "/health" ||
      path.startsWith("/download/folder/")
    ) {
      return rpcWebHandler.handler(request, Context.empty())
    }

    return handler.fetch(request)
  },
})
