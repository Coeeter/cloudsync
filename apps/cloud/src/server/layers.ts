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

const EstablishSessionBody = Schema.Struct({ token: Schema.optional(Schema.String) })

const SessionRoute = HttpRouter.add(
  "POST",
  "/auth/establish",
  Effect.gen(function* () {
    const config = yield* CloudConfig
    const auth = yield* Auth
    const storage = yield* Storage
    const request = yield* HttpServerRequest.HttpServerRequest
    const { token } = yield* HttpServerRequest.schemaBodyJson(EstablishSessionBody)
    const session = yield* auth.authenticate(token, request.headers.cookie)
    let response = yield* HttpServerResponse.json({ ok: true })
    if (token) {
      response = yield* HttpServerResponse.setCookie(response, "cloudsync_session", token, {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        path: "/",
        expires: new Date(session.expiresAt),
      })
    }
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

const LogoutRoute = HttpRouter.add(
  "POST",
  "/auth/logout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const auth = yield* Auth
    yield* auth.revoke(request.headers.cookie)
    return yield* HttpServerResponse.json({ ok: true }).pipe(
      Effect.flatMap((response) =>
        HttpServerResponse.expireCookie(response, "cloudsync_session", { path: "/" }),
      ),
    )
  }).pipe(Effect.orDie),
)

const HealthRoute = HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ ok: true }))

export const RoutesLive = Layer.mergeAll(
  RpcRoutes,
  SessionRoute,
  LogoutRoute,
  HealthRoute,
  HttpRouter.add("POST", "/internal/zip", zipCallback),
).pipe(Layer.provideMerge(ServicesLive))
