import { resolve } from "node:path"
import { Database } from "@cloudsync/db"
import { CloudSyncRpcs } from "@cloudsync/domain"
import { ZipArchive } from "archiver"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { CloudConfig } from "./config"
import { rpcHandlers } from "./rpc-handlers"
import { Auth } from "./services/auth"
import { Catalog } from "./services/catalog"
import { Storage, VIEWER_COOKIE_TTL_SECONDS } from "./services/storage"

const DatabaseLive = Layer.unwrap(
  CloudConfig.pipe(
    Effect.map((config) =>
      Database.layer({
        connectionString: config.databaseUrl,
        migrationsFolder: resolve(config.migrationsDir),
      }),
    ),
  ),
)

export const InfrastructureLive = Layer.mergeAll(DatabaseLive, Storage.layer).pipe(
  Layer.provideMerge(CloudConfig.layer),
)

export const ServicesLive = Layer.mergeAll(Auth.layer, Catalog.layer).pipe(
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

const ArchiveParams = Schema.Struct({ id: Schema.String })

class ArchiveError extends Schema.TaggedError<ArchiveError>()("ArchiveError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const entryWritten = (archive: ZipArchive) =>
  Effect.callback<void, ArchiveError>((resume) => {
    const onEntry = () => {
      archive.off("error", onError)
      resume(Effect.void)
    }
    const onError = (cause: unknown) => {
      archive.off("entry", onEntry)
      resume(Effect.fail(new ArchiveError({ message: "Archive entry failed", cause })))
    }
    archive.once("entry", onEntry)
    archive.once("error", onError)
  })

const archiveName = (name: string) => {
  const fallback = name.replaceAll(/[^a-zA-Z0-9._ -]/g, "_") || "folder"
  return `attachment; filename="${fallback}.zip"; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`
}

const FolderDownloadRoute = HttpRouter.add(
  "GET",
  "/download/folder/:id",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const auth = yield* Auth
    const catalog = yield* Catalog
    const storage = yield* Storage
    const { id } = yield* HttpRouter.schemaPathParams(ArchiveParams)
    yield* auth.authenticate(undefined, request.headers.cookie)
    const folder = yield* catalog.folderArchive(id)
    const archive = new ZipArchive({ zlib: { level: 6 } })

    const produce = Effect.gen(function* () {
      archive.append("", { name: `${folder.name}/` })
      for (const entry of folder.entries) {
        if (!entry.objectKey) {
          archive.append("", { name: `${entry.path}/` })
          continue
        }
        const object = yield* storage.get(entry.objectKey)

        // archiver queues appends; waiting for each entry keeps a single S3 stream open
        // instead of one socket per file in large folders.
        const written = entryWritten(archive)
        archive.append(object.body, { name: entry.path })
        yield* written
      }
      yield* Effect.tryPromise({
        try: () => archive.finalize(),
        catch: (cause) => new ArchiveError({ message: "Could not finalize archive", cause }),
      })
    }).pipe(Effect.tapError((error) => Effect.sync(() => archive.destroy(error))))

    yield* Effect.forkDetach(produce)
    const body = Stream.fromAsyncIterable(
      archive as AsyncIterable<Uint8Array>,
      (cause) => new ArchiveError({ message: "Archive stream failed", cause }),
    )
    return HttpServerResponse.stream(body, {
      contentType: "application/zip",
      headers: { "content-disposition": archiveName(folder.name), "cache-control": "no-store" },
    })
  }).pipe(
    Effect.catch((error) =>
      HttpServerResponse.json(
        { ok: false, message: error instanceof Error ? error.message : "Download failed" },
        { status: 404 },
      ),
    ),
    Effect.orDie,
  ),
)

export const RoutesLive = Layer.mergeAll(
  RpcRoutes,
  SessionRoute,
  LogoutRoute,
  HealthRoute,
  FolderDownloadRoute,
).pipe(Layer.provideMerge(ServicesLive))
