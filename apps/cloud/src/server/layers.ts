import { env } from "cloudflare:workers"
import { Database } from "@cloudsync/db"
import { CloudSyncRpcs } from "@cloudsync/domain"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { zipCallback } from "./zip-callback"
import { CloudConfig } from "./config"
import { rpcHandlers } from "./rpc-handlers"
import { Auth } from "./services/auth"
import { Catalog } from "./services/catalog"
import { Archives } from "./services/archives"
import { Storage, VIEWER_COOKIE_TTL_SECONDS } from "./services/storage"

const DatabaseLive = Database.layer(env.DB)

export const InfrastructureLive = Layer.mergeAll(DatabaseLive, Storage.layer).pipe(
  Layer.provideMerge(CloudConfig.layer),
)

export const ServicesLive = Layer.mergeAll(Auth.layer, Catalog.layer, Archives.layer).pipe(
  Layer.provideMerge(InfrastructureLive),
)

const HandlersLive = CloudSyncRpcs.toLayer(rpcHandlers)

const RpcRoutes = RpcServer.layerHttp({
  group: CloudSyncRpcs,
  path: "/rpc",
  protocol: "http",
}).pipe(Layer.provide([HandlersLive, RpcSerialization.layerJson]))

const ViewerRoute = HttpRouter.add(
  "POST",
  "/auth/viewer",
  Effect.gen(function* () {
    const config = yield* CloudConfig
    const auth = yield* Auth
    const storage = yield* Storage
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* auth.authenticate(request.headers)
    let response = yield* HttpServerResponse.json({ ok: true })
    const viewerCookies = yield* storage.signedViewerCookies
    if (viewerCookies) {
      for (const [name, value] of Object.entries(viewerCookies)) {
        response = yield* HttpServerResponse.setCookie(response, name, value, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: `${VIEWER_COOKIE_TTL_SECONDS} seconds`,
          domain: config.cloudFrontCookieDomain ?? undefined,
        })
      }
    }
    return response
  }).pipe(
    Effect.catch(() => HttpServerResponse.json({ ok: false }, { status: 401 })),
    Effect.orDie,
  ),
)

// Access answers /cdn-cgi/access/logout at the edge; local development has no Access in front.
const LogoutRoute = HttpRouter.add(
  "GET",
  "/auth/logout",
  Effect.map(Auth, (auth) =>
    HttpServerResponse.redirect(auth.mode === "access" ? "/cdn-cgi/access/logout" : "/"),
  ),
)

const DesktopSignIn = Schema.Struct({
  port: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1024, maximum: 65535 }),
  ),
  state: Schema.String.check(Schema.isMinLength(16)),
})

// Loopback redirect for native apps (RFC 8252): the desktop app listens on 127.0.0.1 and opens
// this page in the system browser, which has already passed Access. The Access token is handed
// back so the app can present it as cf-access-token without a session of our own.
const DesktopSignInRoute = HttpRouter.add(
  "GET",
  "/auth/desktop",
  Effect.gen(function* () {
    const auth = yield* Auth
    const request = yield* HttpServerRequest.HttpServerRequest
    const { port, state } = yield* HttpServerRequest.schemaSearchParams(DesktopSignIn)
    yield* auth.authenticate(request.headers)
    const callback = new URL(`http://127.0.0.1:${port}/callback`)
    callback.searchParams.set("state", state)
    callback.searchParams.set("token", request.headers["cf-access-jwt-assertion"] ?? "local")
    return HttpServerResponse.redirect(callback.toString())
  }).pipe(
    Effect.catchTag("CloudSyncError", () =>
      Effect.succeed(HttpServerResponse.text("Unauthorized", { status: 401 })),
    ),
    Effect.catch(() =>
      Effect.succeed(HttpServerResponse.text("Invalid sign-in request", { status: 400 })),
    ),
  ),
)

// Deployment checks call this. Invalid configuration already fails the layer; this also proves
// the D1 binding reaches the migrated schema.
const HealthRoute = HttpRouter.add(
  "GET",
  "/health",
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.execute("health", (db) => db.revision())
    return HttpServerResponse.jsonUnsafe({ ok: true })
  }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.jsonUnsafe({ ok: false }, { status: 503 })),
  ),
)

export const RoutesLive = Layer.mergeAll(
  RpcRoutes,
  ViewerRoute,
  LogoutRoute,
  DesktopSignInRoute,
  HealthRoute,
  HttpRouter.add("POST", "/internal/zip", zipCallback),
).pipe(Layer.provideMerge(ServicesLive))
