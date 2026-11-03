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

export const rpcHandlers = Effect.gen(function* () {
  const auth = yield* Auth
  const catalog = yield* Catalog
  const archives = yield* Archives

  const protect = <A, E>(
    headers: Headers.Headers,
    operation: Effect.Effect<A, E>,
  ): Effect.Effect<A, CloudSyncError> =>
    Effect.gen(function* () {
      const start = Date.now()
      yield* auth.authenticate(headers)
      console.log(`[DEBUG-fin] auth ${Date.now() - start}ms`)
      return yield* operation
    }).pipe(
      Effect.catch((error) => asRpcError(Effect.fail(error))),
      Effect.withSpan("Rpc.authorize"),
    )

  return CloudSyncRpcs.of({
    "auth.session": (_, options) =>
      auth
        .authenticate(options.headers)
        .pipe(Effect.catch((error) => asRpcError(Effect.fail(error)))),
    "catalog.list": ({ parentId, cursor, limit, trashed }, options) =>
      protect(options.headers, catalog.list(parentId, { cursor, limit, trashed })),
    "catalog.search": ({ query, limit }, options) =>
      protect(options.headers, catalog.search(query, limit)),
    "catalog.selectionIds": ({ parentId, query, trashed }, options) =>
      protect(options.headers, catalog.selectionIds(parentId, query, trashed)),
    "catalog.bulk": ({ ids, action, parentId }, options) =>
      protect(options.headers, catalog.bulk(ids, action, parentId)),
    "catalog.retryPreview": ({ id }, options) => protect(options.headers, catalog.retryPreview(id)),
    "catalog.createFolder": ({ parentId, name }, options) =>
      protect(options.headers, catalog.createFolder(parentId, name)),
    "catalog.rename": ({ id, name }, options) => protect(options.headers, catalog.rename(id, name)),
    "catalog.move": ({ id, parentId }, options) =>
      protect(options.headers, catalog.move(id, parentId)),
    "catalog.trash": ({ id }, options) => protect(options.headers, catalog.trash(id)),
    "catalog.recycleBin": (_, options) => protect(options.headers, catalog.recycleBin),
    "catalog.restore": ({ id }, options) => protect(options.headers, catalog.restore(id)),
    "catalog.deletePermanently": ({ id }, options) =>
      protect(options.headers, catalog.deletePermanently(id)),
    "upload.begin": (input, options) => protect(options.headers, catalog.beginUpload(input)),
    "upload.beginPreview": ({ id, previews }, options) =>
      protect(options.headers, catalog.beginPreview(id, previews)),
    "upload.finalize": ({ uploadId }, options) =>
      Effect.suspend(() => {
        const start = Date.now()
        return protect(options.headers, catalog.finalizeUpload(uploadId)).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              console.log(`[DEBUG-fin] ${uploadId.slice(0, 8)} total ${Date.now() - start}ms`),
            ),
          ),
        )
      }),
    "download.file": ({ id }, options) => protect(options.headers, catalog.download(id)),
    "download.archive": ({ ids }, options) => protect(options.headers, archives.create(ids)),
    "download.status": ({ id }, options) => protect(options.headers, archives.status(id)),
  })
})
