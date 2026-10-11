import { CloudSyncError, CloudSyncRpcs } from "@cloudsync/domain"
import { Effect, Schema } from "effect"
import type { Headers } from "effect/unstable/http"
import { Auth } from "./services/auth"
import { Catalog } from "./services/catalog"
import { Archives } from "./services/archives"

function asRpcError<E>(effect: Effect.Effect<never, E>): Effect.Effect<never, CloudSyncError> {
  return effect.pipe(
    Effect.tapError((error) =>
      Effect.logError("RPC operation failed").pipe(
        Effect.annotateLogs({
          errorTag: typeof error === "object" && error && "_tag" in error ? error._tag : "unknown",
        }),
      ),
    ),
    Effect.mapError((error) =>
      Schema.is(CloudSyncError)(error)
        ? error
        : new CloudSyncError({ code: "INTERNAL", message: "The operation could not be completed" }),
    ),
  )
}

function cookieHeader(headers: Headers.Headers): string | undefined {
  return headers.cookie
}

export const rpcHandlers = Effect.gen(function* () {
  const auth = yield* Auth
  const catalog = yield* Catalog
  const archives = yield* Archives

  const protect = <A, E>(
    sessionToken: string | undefined,
    headers: Headers.Headers,
    operation: Effect.Effect<A, E>,
  ): Effect.Effect<A, CloudSyncError> =>
    Effect.gen(function* () {
      yield* auth.authenticate(sessionToken, cookieHeader(headers))
      return yield* operation
    }).pipe(
      Effect.catch((error) => asRpcError(Effect.fail(error))),
      Effect.withSpan("Rpc.authorize"),
    )

  return CloudSyncRpcs.of({
    "auth.requestPin": ({ email }) =>
      auth.requestPin(email).pipe(Effect.catch((error) => asRpcError(Effect.fail(error)))),
    "auth.verifyPin": ({ email, code, client }) =>
      auth
        .verifyPin(email, code, client)
        .pipe(Effect.catch((error) => asRpcError(Effect.fail(error)))),
    "auth.session": ({ sessionToken }, options) =>
      protect(
        sessionToken,
        options.headers,
        auth.authenticate(sessionToken, cookieHeader(options.headers)),
      ),
    "catalog.list": ({ sessionToken, parentId, cursor, limit, trashed }, options) =>
      protect(sessionToken, options.headers, catalog.list(parentId, { cursor, limit, trashed })),
    "catalog.search": ({ sessionToken, query, limit }, options) =>
      protect(sessionToken, options.headers, catalog.search(query, limit)),
    "catalog.selectionIds": ({ sessionToken, parentId, query, trashed }, options) =>
      protect(sessionToken, options.headers, catalog.selectionIds(parentId, query, trashed)),
    "catalog.bulk": ({ sessionToken, ids, action, parentId }, options) =>
      protect(sessionToken, options.headers, catalog.bulk(ids, action, parentId)),
    "catalog.retryPreview": ({ sessionToken, id }, options) =>
      protect(sessionToken, options.headers, catalog.retryPreview(id)),
    "catalog.createFolder": ({ sessionToken, parentId, name }, options) =>
      protect(sessionToken, options.headers, catalog.createFolder(parentId, name)),
    "catalog.rename": ({ sessionToken, id, name }, options) =>
      protect(sessionToken, options.headers, catalog.rename(id, name)),
    "catalog.move": ({ sessionToken, id, parentId }, options) =>
      protect(sessionToken, options.headers, catalog.move(id, parentId)),
    "catalog.trash": ({ sessionToken, id }, options) =>
      protect(sessionToken, options.headers, catalog.trash(id)),
    "catalog.recycleBin": ({ sessionToken }, options) =>
      protect(sessionToken, options.headers, catalog.recycleBin),
    "catalog.restore": ({ sessionToken, id }, options) =>
      protect(sessionToken, options.headers, catalog.restore(id)),
    "catalog.deletePermanently": ({ sessionToken, id }, options) =>
      protect(sessionToken, options.headers, catalog.deletePermanently(id)),
    "upload.begin": ({ sessionToken, ...input }, options) =>
      protect(sessionToken, options.headers, catalog.beginUpload(input)),
    "upload.finalize": ({ sessionToken, uploadId }, options) =>
      protect(sessionToken, options.headers, catalog.finalizeUpload(uploadId)),
    "download.file": ({ sessionToken, id }, options) =>
      protect(sessionToken, options.headers, catalog.download(id)),
    "download.archive": ({ sessionToken, ids }, options) =>
      protect(sessionToken, options.headers, archives.create(ids)),
    "download.status": ({ sessionToken, id }, options) =>
      protect(sessionToken, options.headers, archives.status(id)),
  })
})
