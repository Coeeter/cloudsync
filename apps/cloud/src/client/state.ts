import type { DirectoryListing, Entry, SearchResult, Session } from "@cloudsync/domain"
import { Data, Effect } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import { establishSession, logout, runRpc } from "./rpc"
import { collectDroppedFiles, uploadBrowserFile } from "./upload"

export type AuthView = "checking" | "email" | "pin" | "authenticated"

export interface UploadProgress {
  readonly done: number
  readonly failed: number
  readonly total: number
}

export const registry = AtomRegistry.make()
export const authViewAtom = Atom.make<AuthView>("checking")
export const emailAtom = Atom.make("")
export const sessionAtom = Atom.make<Session | null>(null)
export const listingAtom = Atom.make<DirectoryListing | null>(null)
export const queryAtom = Atom.make("")
export const searchResultsAtom = Atom.make<ReadonlyArray<SearchResult>>([])
export const searchLoadingAtom = Atom.make(false)
export const searchTruncatedAtom = Atom.make(false)
export const recycleEntriesAtom = Atom.make<ReadonlyArray<Entry>>([])
export const busyAtom = Atom.make(false)
export const errorAtom = Atom.make<string | null>(null)
export const noticeAtom = Atom.make<string | null>(null)
export const uploadProgressAtom = Atom.make<UploadProgress | null>(null)
export const dragActiveAtom = Atom.make(false)
export const viewAtom = Atom.make<"files" | "recycle">("files")
/** The Recycle Bin folder being browsed; null shows the Recycle Bin's top-level items. */
export const recycleListingAtom = Atom.make<DirectoryListing | null>(null)
export const loadingMoreAtom = Atom.make(false)
export const activeEntryAtom = Atom.make<Entry | null>(null)
export const moveSourceAtom = Atom.make<Entry | null>(null)
export const moveListingAtom = Atom.make<DirectoryListing | null>(null)
export const newFolderOpenAtom = Atom.make(false)
export const newFolderNameAtom = Atom.make("")
export const renameEntryAtom = Atom.make<Entry | null>(null)
export const renameValueAtom = Atom.make("")
export const pendingDeleteAtom = Atom.make<{
  readonly entry: Entry
  readonly permanent: boolean
} | null>(null)

const message = (error: unknown): string => {
  if (error instanceof BrowserStateError) return message(error.cause)
  if (typeof error === "object" && error !== null) {
    if ("cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause)
      return message(error.cause)
    if ("message" in error && typeof error.message === "string" && error.message)
      return error.message
  }
  return "The operation could not be completed"
}

class BrowserStateError extends Data.TaggedError("BrowserStateError")<{
  readonly cause: unknown
}> {}

const attempt = <A>(tryPromise: () => Promise<A>) =>
  Effect.tryPromise({
    try: tryPromise,
    catch: (cause) => new BrowserStateError({ cause }),
  })

const run = <A>(effect: Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.tapError((error) => Effect.sync(() => registry.set(errorAtom, message(error)))),
      Effect.ignore,
    ),
  )

const currentFolderId = () => registry.get(listingAtom)?.directory?.id ?? null

const needsPreview = (entry: Entry) => entry.kind === "file" && entry.previewStatus === "pending"

let previewPoll: ReturnType<typeof setTimeout> | null = null
let previewPollAttempts = 0

// The worker fills in thumbnails asynchronously after finalization; refresh quietly until they land.
function schedulePreviewPoll(listing: DirectoryListing, reset: boolean) {
  if (previewPoll) clearTimeout(previewPoll)
  previewPoll = null
  if (reset) previewPollAttempts = 0
  if (!listing.entries.some(needsPreview)) return
  previewPollAttempts += 1
  const folderId = listing.directory?.id ?? null
  const delay =
    previewPollAttempts <= 5
      ? 3000
      : Math.min(30_000, 3000 * 2 ** Math.min(previewPollAttempts - 5, 4))
  previewPoll = setTimeout(() => {
    if (registry.get(viewAtom) !== "files" || currentFolderId() !== folderId) return
    if (typeof document !== "undefined" && document.hidden) {
      const current = registry.get(listingAtom)
      if (current) schedulePreviewPoll(current, false)
      return
    }
    const loaded = registry.get(listingAtom)?.entries.length ?? 0
    void run(loadDirectory(folderId, { resetPoll: false, keepQuery: true, limit: loaded }))
  }, delay)
}

let searchRequest = 0

export const actions = {
  boot: (parentId: string | null = null, recycle = false) =>
    run(
      attempt(() => runRpc((client) => client["auth.session"]({}))).pipe(
        Effect.tap((session) =>
          Effect.sync(() => {
            registry.set(sessionAtom, session)
            registry.set(authViewAtom, "authenticated")
          }),
        ),
        // Re-issues the short-lived CloudFront viewer cookies for a long-lived session.
        Effect.tap(() => establishSession(undefined).pipe(Effect.ignore)),
        Effect.flatMap(() => (recycle ? Effect.void : loadDirectory(parentId))),
        Effect.catch(() => Effect.sync(() => registry.set(authViewAtom, "email"))),
      ),
    ),

  requestPin: (email: string) =>
    run(
      withBusy(
        attempt(() => runRpc((client) => client["auth.requestPin"]({ email }))).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.set(emailAtom, email)
              registry.set(authViewAtom, "pin")
              registry.set(noticeAtom, null)
            }),
          ),
        ),
      ),
    ),

  resendPin: () => {
    const email = registry.get(emailAtom)
    return run(
      withBusy(
        attempt(() => runRpc((client) => client["auth.requestPin"]({ email }))).pipe(
          Effect.tap(() => Effect.sync(() => registry.set(noticeAtom, `A new code was sent.`))),
        ),
      ),
    )
  },

  changeEmail: () => {
    registry.set(errorAtom, null)
    registry.set(noticeAtom, null)
    registry.set(authViewAtom, "email")
  },

  verifyPin: (code: string) =>
    run(
      withBusy(
        attempt(() =>
          runRpc((client) =>
            client["auth.verifyPin"]({ email: registry.get(emailAtom), code, client: "web" }),
          ),
        ).pipe(
          Effect.flatMap((session) => establishSession(session.token).pipe(Effect.as(session))),
          Effect.tap((session) =>
            Effect.sync(() => {
              registry.set(sessionAtom, session)
              registry.set(noticeAtom, null)
              registry.set(authViewAtom, "authenticated")
            }),
          ),
          Effect.flatMap(() => loadDirectory(null)),
        ),
      ),
    ),

  logout: () =>
    run(
      logout.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            registry.set(sessionAtom, null)
            registry.set(listingAtom, null)
            registry.set(errorAtom, null)
            registry.set(authViewAtom, "email")
          }),
        ),
      ),
    ),

  dismissError: () => registry.set(errorAtom, null),

  openDirectory: (id: string | null) => run(withBusy(loadDirectory(id))),

  refresh: () => run(loadDirectory(currentFolderId(), { keepQuery: true })),

  showFiles: () => run(withBusy(loadDirectory(currentFolderId()))),

  showRecycleBin: () =>
    run(
      withBusy(
        attempt(() => runRpc((client) => client["catalog.recycleBin"]({}))).pipe(
          Effect.tap((entries) =>
            Effect.sync(() => {
              registry.set(viewAtom, "recycle")
              registry.set(recycleListingAtom, null)
              registry.set(recycleEntriesAtom, entries)
              registry.set(queryAtom, "")
            }),
          ),
        ),
      ),
    ),

  openRecycleFolder: (id: string | null) => {
    if (id === null) return actions.showRecycleBin()
    return run(
      withBusy(
        attempt(() =>
          runRpc((client) => client["catalog.list"]({ parentId: id, trashed: true, limit: 600 })),
        ).pipe(
          Effect.tap((listing) => Effect.sync(() => registry.set(recycleListingAtom, listing))),
        ),
      ),
    )
  },

  loadMore: () => {
    const listing = registry.get(listingAtom)
    if (!listing?.nextCursor || registry.get(loadingMoreAtom) || registry.get(viewAtom) !== "files")
      return Promise.resolve()
    const parentId = listing.directory?.id ?? null
    const cursor = listing.nextCursor
    registry.set(loadingMoreAtom, true)
    return run(
      attempt(() => runRpc((client) => client["catalog.list"]({ parentId, cursor }))).pipe(
        Effect.tap((page) =>
          Effect.sync(() => {
            const currentListing = registry.get(listingAtom)
            if (currentListing?.nextCursor !== cursor) return
            registry.set(listingAtom, {
              ...currentListing,
              entries: [...currentListing.entries, ...page.entries],
              nextCursor: page.nextCursor,
            } as DirectoryListing)
          }),
        ),
        Effect.ensuring(Effect.sync(() => registry.set(loadingMoreAtom, false))),
      ),
    )
  },

  setSearchQuery: (query: string) => {
    registry.set(queryAtom, query)
    registry.set(searchResultsAtom, [])
    registry.set(searchTruncatedAtom, false)
    registry.set(searchLoadingAtom, Boolean(query.trim()))
  },

  search: (query: string) => {
    const request = ++searchRequest
    registry.set(queryAtom, query)
    if (!query.trim()) {
      registry.set(searchResultsAtom, [])
      registry.set(searchTruncatedAtom, false)
      registry.set(searchLoadingAtom, false)
      return Promise.resolve()
    }
    registry.set(searchLoadingAtom, true)
    return run(
      attempt(() => runRpc((client) => client["catalog.search"]({ query, limit: 100 }))).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            if (searchRequest !== request || registry.get(queryAtom) !== query) return
            registry.set(searchResultsAtom, response.results)
            registry.set(searchTruncatedAtom, response.truncated)
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (searchRequest === request) registry.set(searchLoadingAtom, false)
          }),
        ),
      ),
    )
  },

  retryPreview: (entry: Entry) => {
    if (entry.previewStatus !== "failed") return Promise.resolve()
    registry.set(activeEntryAtom, { ...entry, previewStatus: "pending" } as Entry)
    return run(
      attempt(() => runRpc((client) => client["catalog.retryPreview"]({ id: entry.id }))).pipe(
        Effect.flatMap(() =>
          loadDirectory(currentFolderId(), {
            keepQuery: true,
            limit: registry.get(listingAtom)?.entries.length,
          }),
        ),
        Effect.andThen(
          registry.get(queryAtom).trim()
            ? Effect.promise(() => actions.search(registry.get(queryAtom)))
            : Effect.void,
        ),
      ),
    )
  },

  refreshPendingPreviews: () => {
    const listing = registry.get(listingAtom)
    if (!listing?.entries.some(needsPreview) || registry.get(viewAtom) !== "files") return
    void run(
      loadDirectory(currentFolderId(), {
        keepQuery: true,
        limit: listing.entries.length,
      }),
    )
  },

  createFolder: (name: string) => {
    const parentId = currentFolderId()
    return run(
      withBusy(
        attempt(() => runRpc((client) => client["catalog.createFolder"]({ parentId, name }))).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.set(newFolderOpenAtom, false)
              registry.set(newFolderNameAtom, "")
            }),
          ),
          Effect.flatMap(() => loadDirectory(parentId)),
        ),
      ),
    )
  },

  trash: (id: string) =>
    run(
      withBusy(
        attempt(() => runRpc((client) => client["catalog.trash"]({ id }))).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.set(pendingDeleteAtom, null)
              registry.set(activeEntryAtom, null)
            }),
          ),
          Effect.flatMap(() => reloadCurrentView()),
        ),
      ),
    ),

  restore: (id: string) =>
    run(
      withBusy(
        attempt(() => runRpc((client) => client["catalog.restore"]({ id }))).pipe(
          Effect.flatMap(() => reloadRecycleBin()),
        ),
      ),
    ),

  deletePermanently: (id: string) =>
    run(
      withBusy(
        attempt(() => runRpc((client) => client["catalog.deletePermanently"]({ id }))).pipe(
          Effect.tap(() => Effect.sync(() => registry.set(pendingDeleteAtom, null))),
          Effect.flatMap(() => reloadRecycleBin()),
        ),
      ),
    ),

  rename: (entry: Entry, name: string) =>
    run(
      withBusy(
        attempt(() => runRpc((client) => client["catalog.rename"]({ id: entry.id, name }))).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.set(renameEntryAtom, null)
              registry.set(renameValueAtom, "")
            }),
          ),
          Effect.flatMap(() => reloadCurrentView()),
        ),
      ),
    ),

  beginRename: (entry: Entry) => {
    registry.set(renameEntryAtom, entry)
    registry.set(renameValueAtom, entry.name)
  },

  beginMove: (entry: Entry) => {
    registry.set(moveSourceAtom, entry)
    return run(loadMoveDirectory(entry.parentId))
  },

  browseMove: (parentId: string | null) => run(loadMoveDirectory(parentId)),

  confirmMove: () => {
    const source = registry.get(moveSourceAtom)
    if (!source) return Promise.resolve()
    const parentId = registry.get(moveListingAtom)?.directory?.id ?? null
    return run(
      withBusy(
        attempt(() => runRpc((client) => client["catalog.move"]({ id: source.id, parentId }))).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.set(moveSourceAtom, null)
              registry.set(moveListingAtom, null)
            }),
          ),
          Effect.flatMap(() => reloadCurrentView()),
        ),
      ),
    )
  },

  download: (id: string) =>
    run(
      attempt(() => runRpc((client) => client["download.file"]({ id }))).pipe(
        Effect.tap((ticket) => Effect.sync(() => startDownload(ticket.url))),
      ),
    ),

  downloadFolder: (id: string) => startDownload(`/download/folder/${encodeURIComponent(id)}`),

  upload: (files: ReadonlyArray<{ file: File; relativePath: string }>) => {
    const accepted = files.filter(({ file }) => file.name !== ".DS_Store")
    if (accepted.length === 0) return Promise.resolve()
    const parentId = currentFolderId()
    let done = 0
    let failed = 0
    const failures: Array<string> = []
    const publish = () => registry.set(uploadProgressAtom, { done, failed, total: accepted.length })
    publish()
    registry.set(errorAtom, null)
    return run(
      Effect.forEach(
        accepted,
        ({ file, relativePath }) =>
          uploadBrowserFile(file, parentId, relativePath).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.sync(() => {
                  failed += 1
                  failures.push(`${relativePath}: ${message(error)}`)
                  publish()
                }),
              onSuccess: () =>
                Effect.sync(() => {
                  done += 1
                  publish()
                }),
            }),
          ),
        { concurrency: 4, discard: true },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            registry.set(uploadProgressAtom, null)
            if (failures.length > 0) {
              registry.set(
                errorAtom,
                `${failures.length} of ${accepted.length} uploads failed. ${failures.slice(0, 3).join(" · ")}`,
              )
            }
          }),
        ),
        Effect.flatMap(() =>
          currentFolderId() === parentId && registry.get(viewAtom) === "files"
            ? loadDirectory(parentId)
            : Effect.void,
        ),
      ),
    )
  },

  uploadDrop: (items: DataTransferItemList) =>
    run(
      collectDroppedFiles(items).pipe(
        Effect.flatMap((files) =>
          files.length > 0 ? Effect.promise(() => actions.upload(files)) : Effect.void,
        ),
      ),
    ),
}

function startDownload(url: string) {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.rel = "noopener"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function withBusy<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.sync(() => {
    registry.set(busyAtom, true)
    registry.set(errorAtom, null)
  }).pipe(Effect.andThen(effect), Effect.ensuring(Effect.sync(() => registry.set(busyAtom, false))))
}

function loadDirectory(
  parentId: string | null,
  options: {
    readonly resetPoll?: boolean
    readonly keepQuery?: boolean
    readonly limit?: number
  } = {},
) {
  const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 600) : undefined
  return attempt(() => runRpc((client) => client["catalog.list"]({ parentId, limit }))).pipe(
    Effect.tap((listing) =>
      Effect.sync(() => {
        registry.set(viewAtom, "files")
        registry.set(listingAtom, listing)
        if (!options.keepQuery) {
          registry.set(queryAtom, "")
          registry.set(searchResultsAtom, [])
          registry.set(searchLoadingAtom, false)
          registry.set(searchTruncatedAtom, false)
        }
        schedulePreviewPoll(listing, options.resetPoll ?? true)
      }),
    ),
  )
}

function reloadRecycleBin() {
  return attempt(() => runRpc((client) => client["catalog.recycleBin"]({}))).pipe(
    Effect.tap((entries) =>
      Effect.sync(() => {
        registry.set(recycleListingAtom, null)
        registry.set(recycleEntriesAtom, entries)
      }),
    ),
  )
}

function reloadCurrentView() {
  if (registry.get(viewAtom) === "recycle") return reloadRecycleBin()
  const query = registry.get(queryAtom)
  const limit = registry.get(listingAtom)?.entries.length
  if (query.trim()) {
    return loadDirectory(currentFolderId(), { keepQuery: true, limit }).pipe(
      Effect.andThen(Effect.promise(() => actions.search(query))),
    )
  }
  return loadDirectory(currentFolderId(), { limit })
}

function loadMoveDirectory(parentId: string | null) {
  return attempt(() => runRpc((client) => client["catalog.list"]({ parentId }))).pipe(
    Effect.tap((listing) => Effect.sync(() => registry.set(moveListingAtom, listing))),
  )
}
