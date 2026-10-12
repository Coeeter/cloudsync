import {
  CloudSyncError,
  type ArchiveDownload,
  type BulkAction,
  type Breadcrumb,
  type DirectoryListing,
  type Entry,
} from "@cloudsync/domain"
import { Array as Arr, Cause, Effect, Exit, Option, Predicate, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
import { CloudSync, establishSession, logout } from "./rpc"
import {
  retryBrowserPreview,
  collectDroppedFiles,
  type DroppedFile,
  uploadBrowserFile,
} from "./upload"

export const registry = AtomRegistry.make()

const catalogKeys = ["catalog"]
const sessionKeys = ["session"]
/** The server's largest page; refreshes re-fetch at most this many entries in one request. */
const maxPageSize = 600

// UI state is written by route loaders before components subscribe, and unsubscribed atoms reset.
const state = <A>(initial: A) => Atom.keepAlive(Atom.make<A>(initial))

export interface UploadProgress {
  readonly done: number
  readonly failed: number
  readonly total: number
}

export const errorAtom = state<string | null>(null)
export const uploadProgressAtom = state<UploadProgress | null>(null)
export const archiveDownloadsAtom = state<ReadonlyArray<ArchiveDownload>>([])
export const dragActiveAtom = state(false)
export const searchQueryAtom = state("")
export const debouncedSearchQueryAtom = Atom.debounce(searchQueryAtom, "180 millis")
export const activeEntryIdAtom = state<string | null>(null)
export const moveSourceAtom = state<Entry | null>(null)
export const moveFolderIdAtom = state<string | null>(null)
export const newFolderOpenAtom = state(false)
export const newFolderNameAtom = state("")
export const renameEntryAtom = state<Entry | null>(null)
export const renameValueAtom = state("")
export const pendingDeleteAtom = state<{
  readonly entry: Entry
  readonly permanent: boolean
} | null>(null)

export const sessionAtom = CloudSync.runtime
  .atom(
    Effect.gen(function* () {
      const client = yield* CloudSync
      const session = yield* client("auth.session", {})
      // Re-issues the short-lived CloudFront viewer cookies for a long-lived session.
      yield* establishSession(undefined).pipe(Effect.ignore)
      return session
    }),
  )
  .pipe(Atom.withReactivity(sessionKeys), Atom.keepAlive)

export const requestPinAtom = CloudSync.runtime.fn((email: string) =>
  CloudSync.use((client) => client("auth.requestPin", { email })),
)

export const verifyPinAtom = CloudSync.runtime.fn(
  Effect.fnUntraced(function* ({ email, code }: { email: string; code: string }) {
    const client = yield* CloudSync
    const session = yield* client("auth.verifyPin", { email, code, client: "web" })
    yield* establishSession(session.token)
  }),
  { reactivityKeys: sessionKeys },
)

// A full reload drops every cached listing along with the session.
export const signOut = () =>
  Effect.runPromise(logout.pipe(Effect.ignore)).then(() => window.location.assign("/"))

const needsPreview = (entry: Entry) => entry.kind === "file" && entry.previewStatus === "pending"

const loadedCount = (previous: Option.Option<Atom.PullResult<DirectoryListing, unknown>>) =>
  previous.pipe(
    Option.flatMap(AsyncResult.value),
    Option.map(({ items }) => items.reduce((count, page) => count + page.entries.length, 0)),
    Option.filter((count) => count > 0),
    Option.map((count) => Math.min(count, maxPageSize)),
    Option.getOrUndefined,
  )

const listingPages = (
  parentId: string | null,
  firstPageSize: number | undefined,
  pageSize?: number,
) =>
  Stream.paginate({ cursor: undefined as string | undefined, limit: firstPageSize }, (page) =>
    CloudSync.use((client) => client("catalog.list", { parentId, ...page })).pipe(
      Effect.map(
        (listing) =>
          [
            [listing],
            listing.nextCursor
              ? Option.some({ cursor: listing.nextCursor, limit: pageSize })
              : Option.none(),
          ] as const,
      ),
    ),
  )

/** Pages of a folder; writing to the atom loads the next page. */
export const folderAtom = Atom.family((parentId: string | null) =>
  // A refresh restarts the stream, so its first page covers everything already shown and the
  // scroll position stays valid.
  CloudSync.runtime
    .pull((get) => listingPages(parentId, loadedCount(get.self())))
    .pipe(Atom.withReactivity(catalogKeys), Atom.setIdleTTL("10 minutes")),
)

export const isReaderImage = (entry: Entry) =>
  entry.kind === "file" && entry.previewKind === "image"

export interface Reader {
  readonly directory: Entry | null
  readonly breadcrumbs: ReadonlyArray<Breadcrumb>
  readonly images: ReadonlyArray<Entry>
}

/** Every image directly inside a folder, in listing order. */
export const readerAtom = Atom.family((folderId: string) =>
  CloudSync.runtime
    .atom(
      listingPages(folderId, maxPageSize, maxPageSize).pipe(
        Stream.runCollect,
        Effect.map(
          (pages): Reader => ({
            directory: pages[0]?.directory ?? null,
            breadcrumbs: pages[0]?.breadcrumbs ?? [],
            images: pages.flatMap((page) => page.entries).filter(isReaderImage),
          }),
        ),
      ),
    )
    .pipe(Atom.withReactivity(catalogKeys), Atom.setIdleTTL("10 minutes")),
)

/** Reader route loader: null when signed out or the folder cannot be read. */
export const loadReader = (folderId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* AtomRegistry.getResult(registry, sessionAtom, {
        suspendOnWaiting: true,
      }).pipe(Effect.option)
      if (Option.isNone(session)) return null
      yield* revalidate(readerAtom(folderId))
      return Option.getOrNull(AsyncResult.value(registry.get(readerAtom(folderId))))
    }),
  )

export const recycleBinAtom = CloudSync.query(
  "catalog.recycleBin",
  {},
  { reactivityKeys: catalogKeys, timeToLive: "1 minute" },
)

export const trashedFolderAtom = Atom.family((parentId: string) =>
  CloudSync.query(
    "catalog.list",
    { parentId, trashed: true, limit: maxPageSize },
    { reactivityKeys: catalogKeys, timeToLive: "1 minute" },
  ),
)

export const moveFolderAtom = Atom.family((parentId: string | null) =>
  CloudSync.query(
    "catalog.list",
    { parentId, limit: maxPageSize },
    { reactivityKeys: catalogKeys, timeToLive: "1 minute" },
  ),
)

export const searchAtom = CloudSync.runtime
  .atom((get) => {
    const query = get(debouncedSearchQueryAtom).trim()
    if (!query) return Effect.succeed(null)
    return CloudSync.use((client) => client("catalog.search", { query, limit: 100 }))
  })
  .pipe(Atom.withReactivity(catalogKeys))

export interface FolderView {
  readonly directory: Entry | null
  readonly breadcrumbs: ReadonlyArray<Breadcrumb>
  readonly entries: ReadonlyArray<Entry>
  readonly hasMore: boolean
  readonly loaded: boolean
  readonly waiting: boolean
  readonly error: string | null
}

const viewOf = <A, E>(
  result: AsyncResult.AsyncResult<A, E>,
  toView: (value: A) => Omit<FolderView, "loaded" | "waiting" | "error">,
): FolderView => ({
  ...Option.match(AsyncResult.value(result), {
    onNone: () => ({ directory: null, breadcrumbs: [], entries: [], hasMore: false }),
    onSome: toView,
  }),
  loaded: Option.isSome(AsyncResult.value(result)),
  waiting: result.waiting,
  error: AsyncResult.isFailure(result) ? describe(result.cause) : null,
})

// Only the folder on screen refreshes on focus or polls; cached folders stay idle until revisited.
export const folderViewAtom = Atom.family((parentId: string | null) => {
  const pages = folderAtom(parentId)
  let previewPolls = 0
  return Atom.readable((get) => {
    get.subscribe(Atom.windowFocusSignal, () => get.refresh(pages))
    const result = get(pages)
    // The worker fills in thumbnails after finalization; refresh with backoff until they land.
    if (AsyncResult.isSuccess(result) && !result.waiting && !document.hidden) {
      if (result.value.items.some((page) => page.entries.some(needsPreview))) {
        previewPolls += 1
        const delay =
          previewPolls <= 5 ? 3000 : Math.min(30_000, 3000 * 2 ** Math.min(previewPolls - 5, 4))
        const timer = setTimeout(() => get.refresh(pages), delay)
        get.addFinalizer(() => clearTimeout(timer))
      } else {
        previewPolls = 0
      }
    }
    return viewOf(result, ({ items }) => ({
      directory: items[0].directory,
      breadcrumbs: items[0].breadcrumbs,
      entries: items.flatMap((page) => page.entries),
      hasMore: Arr.lastNonEmpty(items).nextCursor !== null,
    }))
  })
})

export const recycleViewAtom = Atom.family((parentId: string | null) =>
  Atom.readable((get) =>
    parentId === null
      ? viewOf(get(recycleBinAtom), (entries) => ({
          directory: null,
          breadcrumbs: [{ id: null, name: "Recycle Bin" }],
          entries,
          hasMore: false,
        }))
      : viewOf(get(trashedFolderAtom(parentId)), (listing) => ({
          directory: listing.directory,
          breadcrumbs: listing.breadcrumbs,
          entries: listing.entries,
          hasMore: false,
        })),
  ),
)

/** Route loader: resolves once the destination can render, so scroll restoration has content. */
export const visit = (folder: string | null, recycle: boolean) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* AtomRegistry.getResult(registry, sessionAtom, {
        suspendOnWaiting: true,
      }).pipe(Effect.option)
      if (Option.isNone(session)) return
      if (!recycle) return yield* revalidate(folderAtom(folder))
      if (folder === null) return yield* revalidate(recycleBinAtom)
      return yield* revalidate(trashedFolderAtom(folder))
    }),
  )

// A cached atom answers immediately with its previous value while the refresh runs behind it.
const revalidate = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  Effect.suspend(() => {
    if (!AsyncResult.isInitial(registry.get(atom))) registry.refresh(atom)
    return AtomRegistry.getResult(registry, atom).pipe(Effect.ignore)
  })

const catalogFn = <Arg, A, E>(
  run: (arg: Arg, client: CloudSync["Service"]) => Effect.Effect<A, E>,
) =>
  CloudSync.runtime.fn((arg: Arg) => CloudSync.use((client) => run(arg, client)), {
    reactivityKeys: catalogKeys,
  })

export const createFolderAtom = catalogFn(
  (input: { parentId: string | null; name: string }, client) =>
    client("catalog.createFolder", input),
)
export const renameAtom = catalogFn((input: { id: string; name: string }, client) =>
  client("catalog.rename", input),
)
export const moveAtom = catalogFn((input: { id: string; parentId: string | null }, client) =>
  client("catalog.move", input),
)
export const trashAtom = catalogFn((id: string, client) => client("catalog.trash", { id }))
export const restoreAtom = catalogFn((id: string, client) => client("catalog.restore", { id }))
export const deletePermanentlyAtom = catalogFn((id: string, client) =>
  client("catalog.deletePermanently", { id }),
)
export const retryPreviewAtom = CloudSync.runtime.fn((entry: Entry) => retryBrowserPreview(entry), {
  reactivityKeys: catalogKeys,
})

export const downloadAtom = CloudSync.runtime.fn(
  (id: string) =>
    CloudSync.use((client) => client("download.file", { id })).pipe(
      Effect.tap((ticket) => Effect.sync(() => startDownload(ticket.url))),
    ),
  { concurrent: true },
)

export const selectionIdsAtom = CloudSync.runtime.fn(
  (input: { parentId: string | null; query?: string; trashed?: boolean }) =>
    CloudSync.use((client) => client("catalog.selectionIds", input)),
)

export const bulkAtom = catalogFn(
  (input: { ids: ReadonlyArray<string>; action: BulkAction; parentId?: string | null }, client) =>
    client("catalog.bulk", input),
)

const recordArchive = (download: ArchiveDownload) =>
  registry.update(archiveDownloadsAtom, (previous) => [
    download,
    ...previous.filter((item) => item.id !== download.id),
  ])

export const downloadArchiveAtom = CloudSync.runtime.fn(
  Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
    const client = yield* CloudSync
    let download = yield* client("download.archive", { ids })
    while (true) {
      yield* Effect.sync(() => recordArchive(download))
      if (download.status === "failed")
        return yield* new CloudSyncError({
          code: "INTERNAL",
          message: download.error ?? "ZIP preparation failed",
        })
      if (download.url) {
        const url = download.url
        yield* Effect.sync(() => startDownload(url))
        return download
      }
      yield* Effect.sleep("1 second")
      download = yield* client("download.status", { id: download.id })
    }
  }),
  { concurrent: true },
)

export const redownloadArchiveAtom = CloudSync.runtime.fn((id: string) =>
  CloudSync.use((client) =>
    client("download.status", { id }).pipe(
      Effect.tap((download) =>
        Effect.sync(() => {
          recordArchive(download)
          if (download.url) startDownload(download.url)
        }),
      ),
    ),
  ),
)

export const downloadFolder = (id: string) => void mutate(downloadArchiveAtom, [id])

export type UploadSource = ReadonlyArray<DroppedFile> | DataTransferItemList

export const uploadAtom = CloudSync.runtime.fn(
  Effect.fnUntraced(function* ({
    parentId,
    source,
  }: {
    readonly parentId: string | null
    readonly source: UploadSource
  }) {
    const files =
      source instanceof DataTransferItemList ? yield* collectDroppedFiles(source) : source
    const accepted = files.filter(({ file }) => file.name !== ".DS_Store")
    if (accepted.length === 0) return
    let done = 0
    let failed = 0
    const failures: Array<string> = []
    const publish = Effect.suspend(() =>
      Atom.set(uploadProgressAtom, { done, failed, total: accepted.length }),
    )
    yield* publish
    yield* Effect.forEach(
      accepted,
      ({ file, relativePath }) =>
        uploadBrowserFile(file, parentId, relativePath).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              failed += 1
              failures.push(`${relativePath}: ${error.message}`)
              return publish
            },
            onSuccess: () => {
              done += 1
              return publish
            },
          }),
        ),
      { concurrency: 4, discard: true },
    ).pipe(Effect.ensuring(Atom.set(uploadProgressAtom, null)))
    if (failures.length > 0) {
      yield* Atom.set(
        errorAtom,
        `${failures.length} of ${accepted.length} uploads failed. ${failures.slice(0, 3).join(" · ")}`,
      )
    }
  }),
  { reactivityKeys: catalogKeys, concurrent: true },
)

/** Runs a mutation from an event handler; a failure is shown in the error banner. */
export function mutate<Arg, A, E>(
  atom: Atom.AtomResultFn<Arg, A, E>,
  arg: Arg,
): Promise<Exit.Exit<A, E>> {
  registry.set(errorAtom, null)
  const release = registry.mount(atom)
  registry.set(atom, arg)
  return Effect.runPromiseExit(
    AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
  ).then((exit) => {
    release()
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      registry.set(errorAtom, describe(exit.cause))
    }
    return exit
  })
}

function describe(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  return Predicate.hasProperty(error, "message") &&
    Predicate.isString(error.message) &&
    error.message
    ? error.message
    : "The operation could not be completed"
}

function startDownload(url: string) {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.rel = "noopener"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}
