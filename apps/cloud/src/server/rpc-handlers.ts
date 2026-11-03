import { CloudSyncError, CloudSyncRpcs, MAX_UPLOAD_BATCH } from "@cloudsync/domain"
import { Effect, Schema } from "effect"
import type { Headers } from "effect/unstable/http"
import { Auth } from "./services/auth"
import { Catalog } from "./services/catalog"
import { Archives } from "./services/archives"
import { invalidInput } from "./errors"

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

function settle<A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<{ readonly value: A } | { readonly error: CloudSyncError }> {
  return effect.pipe(
    Effect.map((value) => ({ value })),
    Effect.catch((error) =>
      asRpcError(Effect.fail(error)).pipe(
        Effect.catch((rpcError) => Effect.succeed({ error: rpcError })),
      ),
    ),
  )
}

function eachUpload<I, A, E>(
  items: ReadonlyArray<I>,
  operation: (item: I) => Effect.Effect<A, E>,
): Effect.Effect<
  ReadonlyArray<{ readonly value: A } | { readonly error: CloudSyncError }>,
  CloudSyncError
> {
  return items.length > MAX_UPLOAD_BATCH
    ? Effect.fail(invalidInput(`At most ${MAX_UPLOAD_BATCH} uploads per batch`))
    : Effect.forEach(items, (item) => settle(operation(item)), { concurrency: 10 })
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
      yield* auth.authenticate(headers)
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
    "catalog.search": ({ query, limit, parentId }, options) =>
      protect(options.headers, catalog.search(query, limit, parentId)),
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
      protect(options.headers, catalog.finalizeUpload(uploadId)),
    "upload.beginMany": ({ uploads }, options) =>
      protect(
        options.headers,
        eachUpload(uploads, catalog.beginUpload).pipe(
          Effect.map((results) => results.map((r) => ("value" in r ? { ticket: r.value } : r))),
        ),
      ),
    "upload.finalizeMany": ({ uploadIds }, options) =>
      protect(
        options.headers,
        eachUpload(uploadIds, catalog.finalizeUpload).pipe(
          Effect.map((results) => results.map((r) => ("value" in r ? { entry: r.value } : r))),
        ),
      ),
    "download.file": ({ id }, options) => protect(options.headers, catalog.download(id)),
    "download.archive": ({ ids }, options) => protect(options.headers, archives.create(ids)),
    "download.status": ({ id }, options) => protect(options.headers, archives.status(id)),
  })
})
