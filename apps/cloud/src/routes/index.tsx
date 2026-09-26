import type { Entry } from "@cloudsync/domain"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@cloudsync/ui/components/alert-dialog"
import { Button } from "@cloudsync/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cloudsync/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudsync/ui/components/dropdown-menu"
import { Input } from "@cloudsync/ui/components/input"
import { Progress } from "@cloudsync/ui/components/progress"
import { createFileRoute } from "@tanstack/react-router"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileArchive,
  FileIcon,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  ImageIcon,
  LogOut,
  MoreHorizontal,
  Move,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react"
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react"
import {
  actions,
  activeEntryAtom,
  authViewAtom,
  busyAtom,
  dragActiveAtom,
  emailAtom,
  errorAtom,
  listingAtom,
  loadingMoreAtom,
  moveListingAtom,
  moveSourceAtom,
  newFolderNameAtom,
  newFolderOpenAtom,
  noticeAtom,
  pendingDeleteAtom,
  queryAtom,
  recycleEntriesAtom,
  recycleListingAtom,
  registry,
  renameEntryAtom,
  renameValueAtom,
  searchResultsAtom,
  searchLoadingAtom,
  searchTruncatedAtom,
  uploadProgressAtom,
  viewAtom,
} from "../client/state"
import { useAtomValue } from "../client/use-atom"

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    folder: typeof search.folder === "string" && search.folder ? search.folder : undefined,
    recycle: search.recycle === true || search.recycle === "true" ? true : undefined,
  }),
  component: CloudSyncApp,
})

function CloudSyncApp() {
  const authView = useAtomValue(authViewAtom)
  const location = Route.useSearch()
  const initialLocation = useRef(location)

  useEffect(() => {
    void actions.boot(
      initialLocation.current.folder ?? null,
      initialLocation.current.recycle === true,
    )
  }, [])

  if (authView !== "authenticated") return <AuthScreen view={authView} />
  return <FileBrowser />
}

function AuthScreen({ view }: { view: "checking" | "email" | "pin" }) {
  const busy = useAtomValue(busyAtom)
  const error = useAtomValue(errorAtom)
  const notice = useAtomValue(noticeAtom)
  const savedEmail = useAtomValue(emailAtom)
  const [code, setCode] = useState("")

  useEffect(() => {
    if (view === "pin") setCode("")
  }, [view])

  if (view === "checking") {
    return (
      <main className="auth-screen">
        <p className="auth-copy">Opening your archive…</p>
      </main>
    )
  }

  const submitEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim()
    if (email) void actions.requestPin(email)
  }

  const submitCode = (value: string) => {
    if (value.length === 6 && !busy) void actions.verifyPin(value)
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <h1 className="auth-title">CloudSync</h1>
        {view === "email" ? (
          <form key="email" className="auth-form" onSubmit={submitEmail}>
            <p className="auth-copy">Enter the owner email to receive a sign-in code.</p>
            <Input
              type="email"
              name="email"
              autoComplete="email"
              defaultValue={savedEmail}
              placeholder="you@example.com"
              required
              autoFocus
            />
            {error ? <p className="error-copy">{error}</p> : null}
            <Button disabled={busy}>{busy ? "Sending…" : "Send code"}</Button>
          </form>
        ) : (
          <form
            key="pin"
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault()
              submitCode(code)
            }}
          >
            <p className="auth-copy">
              Enter the six-digit code sent to <strong className="auth-email">{savedEmail}</strong>.
            </p>
            <Input
              className="pin-input"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="••••••"
              value={code}
              onChange={(event) => {
                const next = event.target.value.replaceAll(/\D/g, "").slice(0, 6)
                setCode(next)
                submitCode(next)
              }}
              required
              autoFocus
            />
            {error ? <p className="error-copy">{error}</p> : null}
            {notice ? <p className="notice-copy">{notice}</p> : null}
            <Button disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Open archive"}
            </Button>
            <div className="auth-links">
              <button type="button" onClick={actions.changeEmail} disabled={busy}>
                Use a different email
              </button>
              <button type="button" onClick={() => void actions.resendPin()} disabled={busy}>
                Resend code
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  )
}

function FileBrowser() {
  const location = Route.useSearch()
  const navigate = Route.useNavigate()
  const listing = useAtomValue(listingAtom)
  const query = useAtomValue(queryAtom)
  const searchResults = useAtomValue(searchResultsAtom)
  const searchLoading = useAtomValue(searchLoadingAtom)
  const searchTruncated = useAtomValue(searchTruncatedAtom)
  const recycleEntries = useAtomValue(recycleEntriesAtom)
  const error = useAtomValue(errorAtom)
  const progress = useAtomValue(uploadProgressAtom)
  const dragActive = useAtomValue(dragActiveAtom)
  const view = useAtomValue(viewAtom)
  const activeEntry = useAtomValue(activeEntryAtom)
  const moveSource = useAtomValue(moveSourceAtom)
  const newFolderOpen = useAtomValue(newFolderOpenAtom)
  const newFolderName = useAtomValue(newFolderNameAtom)
  const renameEntry = useAtomValue(renameEntryAtom)
  const renameValue = useAtomValue(renameValueAtom)
  const pendingDelete = useAtomValue(pendingDeleteAtom)
  const recycleListing = useAtomValue(recycleListingAtom)
  const loadingMore = useAtomValue(loadingMoreAtom)
  const sentinel = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragDepth = useRef(0)
  const routeFolder = location.folder ?? null
  const navigateFolder = (folder: string | null, recycle = location.recycle === true) =>
    navigate({
      search: {
        folder: folder ?? undefined,
        recycle: recycle ? true : undefined,
      },
    })

  const onSearch = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    actions.setSearchQuery(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => void actions.search(value), 180)
  }

  const uploadInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }))
    event.target.value = ""
    if (files.length > 0) void actions.upload(files)
  }

  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files")
  const canDrop = view === "files" && !query.trim()

  // dragenter/dragleave fire for every child element, so track depth instead of targets.
  const onDragEnter = (event: DragEvent) => {
    if (!carriesFiles(event) || !canDrop) return
    event.preventDefault()
    dragDepth.current += 1
    registry.set(dragActiveAtom, true)
  }
  const onDragLeave = (event: DragEvent) => {
    if (!carriesFiles(event) || !canDrop) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) registry.set(dragActiveAtom, false)
  }
  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    registry.set(dragActiveAtom, false)
    if (canDrop) void actions.uploadDrop(event.dataTransfer.items)
  }

  const searching = view === "files" && query.trim().length > 0
  const entries =
    view === "recycle"
      ? (recycleListing?.entries ?? recycleEntries)
      : searching
        ? searchResults.map((result) => result.entry)
        : (listing?.entries ?? [])
  const searchPathById = new Map(
    searchResults.map((result) => [result.entry.id, result.parentPath]),
  )
  const recycleMode = view === "recycle" ? (recycleListing ? "nested" : "root") : null
  const hasMore = view === "files" && !searching && Boolean(listing?.nextCursor)

  // Re-observing after every page makes the observer fire again while the sentinel is still
  // on screen, so tall viewports keep filling instead of stalling after one page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextCursor intentionally re-arms the observer
  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) void actions.loadMore()
      },
      { rootMargin: "1200px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, listing?.nextCursor])

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) actions.refreshPendingPreviews()
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [])

  useEffect(() => {
    if (location.recycle) {
      const current = recycleListing?.directory?.id ?? null
      if (view !== "recycle") {
        void actions.showRecycleBin()
      } else if (current !== routeFolder) {
        void actions.openRecycleFolder(routeFolder)
      }
      return
    }
    const current = listing?.directory?.id ?? null
    if (view !== "files" || current !== routeFolder) void actions.openDirectory(routeFolder)
  }, [location.recycle, routeFolder, view, listing?.directory?.id, recycleListing?.directory?.id])

  return (
    <main
      className="app-shell"
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        if (carriesFiles(event)) event.preventDefault()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="topbar">
        <nav className="breadcrumb" aria-label="Current folder">
          {view === "recycle" ? (
            <>
              <button type="button" onClick={() => void navigateFolder(null, false)}>
                CloudSync
              </button>
              {(recycleListing?.breadcrumbs ?? [{ id: null, name: "Recycle Bin" }]).map(
                (crumb, index, crumbs) => (
                  <span key={crumb.id ?? "recycle"} className="crumb">
                    <span aria-hidden="true">/</span>
                    <button
                      type="button"
                      aria-current={index === crumbs.length - 1 ? "page" : undefined}
                      onClick={() => void navigateFolder(crumb.id, true)}
                    >
                      {crumb.name}
                    </button>
                  </span>
                ),
              )}
            </>
          ) : (
            (listing?.breadcrumbs ?? []).map((crumb, index, crumbs) => (
              <span key={crumb.id ?? "root"} className="crumb">
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                <button
                  type="button"
                  aria-current={index === crumbs.length - 1 ? "page" : undefined}
                  onClick={() => void navigateFolder(crumb.id, false)}
                >
                  {crumb.name}
                </button>
              </span>
            ))
          )}
        </nav>
        <div className="top-actions">
          {view === "files" ? (
            <>
              <div className="search-wrap">
                <Search className="search-icon" size={16} strokeWidth={1.8} />
                <Input
                  className="search-input"
                  value={query}
                  onChange={onSearch}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") void actions.search("")
                  }}
                  placeholder="Search names and paths"
                  aria-label="Search archive"
                />
                {query ? (
                  <button
                    type="button"
                    className="search-clear"
                    aria-label="Clear search"
                    onClick={() => void actions.search("")}
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
              <Button
                size="icon"
                variant="ghost"
                title="New folder"
                aria-label="New folder"
                onClick={() => registry.set(newFolderOpenAtom, true)}
              >
                <FolderPlus size={18} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Upload folder"
                aria-label="Upload folder"
                onClick={() => folderInput.current?.click()}
              >
                <FolderInput size={18} />
              </Button>
              <Button onClick={() => fileInput.current?.click()}>
                <Upload size={16} />
                <span className="desktop-label">Upload</span>
              </Button>
            </>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label="More">
                <MoreHorizontal size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {view === "files" ? (
                <DropdownMenuItem onSelect={() => void navigateFolder(null, true)}>
                  <Trash2 /> Recycle Bin
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => void navigateFolder(null, false)}>
                  <Folder /> Back to files
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void actions.logout()}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input ref={fileInput} hidden type="file" multiple onChange={uploadInput} />
          <input
            ref={folderInput}
            hidden
            type="file"
            multiple
            onChange={uploadInput}
            {...({ webkitdirectory: "" } as object)}
          />
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss" onClick={actions.dismissError}>
            <X size={14} />
          </button>
        </div>
      ) : null}
      {progress ? (
        <div className="upload-progress" aria-live="polite">
          <span>
            Uploading {progress.done + progress.failed} of {progress.total}
            {progress.failed > 0 ? ` · ${progress.failed} failed` : ""}
          </span>
          <Progress value={((progress.done + progress.failed) / progress.total) * 100} />
        </div>
      ) : null}
      {recycleMode === "root" ? (
        <p className="view-note">Items here are permanently deleted after 30 days.</p>
      ) : null}
      {recycleMode === "nested" ? (
        <p className="view-note">
          Viewing a deleted folder. Restore it from the Recycle Bin to bring it back.
        </p>
      ) : null}
      {searching ? (
        <p className="view-note">
          {searchLoading
            ? `Searching for “${query.trim()}”…`
            : `${searchResults.length}${searchTruncated ? "+" : ""} result${searchResults.length === 1 && !searchTruncated ? "" : "s"} for “${query.trim()}”${searchTruncated ? " · showing the first 100" : ""}`}
        </p>
      ) : null}

      {entries.length > 0 ? (
        <section
          className="file-grid"
          aria-label={searching ? "Search results" : "Folder contents"}
        >
          {entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              recycle={recycleMode}
              searchPath={searching ? searchPathById.get(entry.id) : undefined}
              openDirectory={(id) => void navigateFolder(id, recycleMode !== null)}
            />
          ))}
        </section>
      ) : (
        <section className="empty-state">
          <div>
            {recycleMode === "root" ? (
              <Trash2 size={40} strokeWidth={1.2} />
            ) : (
              <Folder size={40} strokeWidth={1.2} />
            )}
            <p>
              {recycleMode === "root"
                ? "Recycle Bin is empty"
                : recycleMode === "nested"
                  ? "This folder is empty"
                  : searching
                    ? searchLoading
                      ? "Searching…"
                      : "No matching files"
                    : listing
                      ? "Drop files here or upload a folder"
                      : "Loading…"}
            </p>
          </div>
        </section>
      )}

      {hasMore ? (
        <div ref={sentinel} className="load-more" aria-live="polite">
          {loadingMore ? "Loading more…" : null}
        </div>
      ) : null}

      {dragActive ? (
        <div className="drop-overlay">Add to {listing?.directory?.name ?? "CloudSync"}</div>
      ) : null}
      <NewFolderDialog open={newFolderOpen} name={newFolderName} />
      <RenameDialog entry={renameEntry} value={renameValue} />
      <DeleteDialog pending={pendingDelete} />
      <Lightbox entry={activeEntry} entries={entries} />
      <MoveDialog source={moveSource} />
    </main>
  )
}

function EntryCard({
  entry,
  recycle,
  searchPath,
  openDirectory,
}: {
  entry: Entry
  recycle: "root" | "nested" | null
  searchPath?: string
  openDirectory: (id: string) => void
}) {
  const [broken, setBroken] = useState(false)
  const fallback =
    entry.kind === "directory" ? (
      <Folder className="directory-mark" size={52} strokeWidth={1.25} />
    ) : entry.previewKind === "image" ? (
      <ImageIcon className="entry-fallback" size={40} strokeWidth={1.2} />
    ) : entry.previewKind === "video" ? (
      <Video className="entry-fallback" size={40} strokeWidth={1.2} />
    ) : entry.previewKind === "pdf" ? (
      <FileText className="entry-fallback" size={40} strokeWidth={1.2} />
    ) : entry.mimeType?.includes("zip") ? (
      <FileArchive className="entry-fallback" size={40} strokeWidth={1.2} />
    ) : (
      <FileIcon className="entry-fallback" size={40} strokeWidth={1.2} />
    )

  const open = () => {
    if (entry.kind === "directory") {
      openDirectory(entry.id)
    } else registry.set(activeEntryAtom, entry)
  }

  return (
    <article className="entry-card" data-kind={entry.kind}>
      <button type="button" className="entry-open" onClick={open} title={entry.name}>
        <div className="entry-viewport">
          {entry.thumbnailUrl && !broken ? (
            <img
              className="entry-preview"
              src={entry.thumbnailUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setBroken(true)}
            />
          ) : (
            fallback
          )}
          {entry.kind === "file" && entry.previewKind === "video" && entry.thumbnailUrl ? (
            <span className="entry-badge">
              <Video size={12} />
            </span>
          ) : null}
          {entry.kind === "file" &&
          entry.previewStatus !== "ready" &&
          entry.previewKind !== "none" ? (
            <span className="preview-state" data-state={entry.previewStatus}>
              {entry.previewStatus === "failed" ? "Preview failed" : "Processing preview"}
            </span>
          ) : null}
        </div>
        <div className="entry-meta">
          <span className="entry-name">{entry.name}</span>
          {searchPath ? <span className="entry-path">{searchPath}</span> : null}
          <span className="entry-detail">
            {entry.kind === "directory"
              ? `${entry.childCount} item${entry.childCount === 1 ? "" : "s"}`
              : formatBytes(entry.size)}
          </span>
        </div>
      </button>
      {recycle === "nested" ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="entry-menu-button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Actions for ${entry.name}`}
            >
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {recycle ? (
              <>
                <DropdownMenuItem onSelect={() => void actions.restore(entry.id)}>
                  <RotateCcw /> Restore
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => registry.set(pendingDeleteAtom, { entry, permanent: true })}
                >
                  <Trash2 /> Delete permanently
                </DropdownMenuItem>
              </>
            ) : (
              <>
                {entry.kind === "file" ? (
                  <>
                    <DropdownMenuItem onSelect={() => void actions.download(entry.id)}>
                      <Download /> Download
                    </DropdownMenuItem>
                    {entry.previewStatus === "failed" ? (
                      <DropdownMenuItem onSelect={() => void actions.retryPreview(entry)}>
                        <RotateCcw /> Retry preview
                      </DropdownMenuItem>
                    ) : null}
                  </>
                ) : (
                  <DropdownMenuItem onSelect={() => actions.downloadFolder(entry.id)}>
                    <Download /> Download ZIP
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => actions.beginRename(entry)}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void actions.beginMove(entry)}>
                  <Move /> Move
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => registry.set(pendingDeleteAtom, { entry, permanent: false })}
                >
                  <Trash2 /> Move to Recycle Bin
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </article>
  )
}

function NewFolderDialog({ open, name }: { open: boolean; name: string }) {
  const busy = useAtomValue(busyAtom)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        registry.set(newFolderOpenAtom, next)
        if (!next) registry.set(newFolderNameAtom, "")
      }}
    >
      <DialogContent>
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) void actions.createFolder(name.trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Created in the folder you are viewing.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => registry.set(newFolderNameAtom, event.target.value)}
            placeholder="Folder name"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => registry.set(newFolderOpenAtom, false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RenameDialog({ entry, value }: { entry: Entry | null; value: string }) {
  const busy = useAtomValue(busyAtom)
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) registry.set(renameEntryAtom, null)
      }}
    >
      <DialogContent>
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (entry && value.trim() && value.trim() !== entry.name)
              void actions.rename(entry, value.trim())
            else registry.set(renameEntryAtom, null)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>Choose a new name for “{entry?.name}”.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onFocus={(event) => {
              const dot = event.target.value.lastIndexOf(".")
              if (entry?.kind === "file" && dot > 0) event.target.setSelectionRange(0, dot)
              else event.target.select()
            }}
            onChange={(event) => registry.set(renameValueAtom, event.target.value)}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => registry.set(renameEntryAtom, null)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim() || busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({ pending }: { pending: { entry: Entry; permanent: boolean } | null }) {
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) registry.set(pendingDeleteAtom, null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pending?.permanent ? "Delete permanently?" : "Move to Recycle Bin?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.permanent
              ? `“${pending.entry.name}” and its contents cannot be recovered after this.`
              : `“${pending?.entry.name}” stays recoverable from the Recycle Bin for 30 days.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (!pending) return
              if (pending.permanent) void actions.deletePermanently(pending.entry.id)
              else void actions.trash(pending.entry.id)
            }}
          >
            {pending?.permanent ? "Delete permanently" : "Move to Recycle Bin"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function Lightbox({ entry, entries }: { entry: Entry | null; entries: ReadonlyArray<Entry> }) {
  const files = entries.filter((item) => item.kind === "file")
  const index = entry ? files.findIndex((item) => item.id === entry.id) : -1
  const swipeStart = useRef<{ x: number; y: number } | null>(null)

  const step = (offset: number) => {
    if (files.length < 2 || index < 0) return
    registry.set(activeEntryAtom, files[(index + offset + files.length) % files.length] ?? null)
  }
  const stepRef = useRef(step)
  stepRef.current = step

  useEffect(() => {
    if (!entry) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") stepRef.current(-1)
      if (event.key === "ArrowRight") stepRef.current(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [entry])

  useEffect(() => {
    if (index < 0 || files.length < 2) return
    for (const offset of [1, -1]) {
      const neighbour = files[(index + offset + files.length) % files.length]
      if (neighbour?.previewKind === "image" && neighbour.previewUrl) {
        new Image().src = neighbour.previewUrl
      }
    }
  }, [index, files])

  const onPointerDown = (event: PointerEvent) => {
    swipeStart.current = { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: PointerEvent) => {
    const start = swipeStart.current
    swipeStart.current = null
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1)
  }

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) registry.set(activeEntryAtom, null)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="lightbox top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-[#050506] p-0 shadow-none sm:max-w-none"
      >
        <header className="lightbox-bar">
          <div className="lightbox-title">
            <DialogTitle className="lightbox-name">{entry?.name}</DialogTitle>
            <DialogDescription className="lightbox-meta">
              {entry ? formatBytes(entry.size) : ""}
              {files.length > 1 && index >= 0 ? ` · ${index + 1} / ${files.length}` : ""}
              {entry?.previewStatus === "failed" ? " · preview failed" : ""}
            </DialogDescription>
          </div>
          {entry ? (
            entry.previewStatus === "failed" ? (
              <Button variant="ghost" onClick={() => void actions.retryPreview(entry)}>
                <RotateCcw size={16} /> Retry preview
              </Button>
            ) : null
          ) : null}
          {entry ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Download"
              title="Download"
              onClick={() => void actions.download(entry.id)}
            >
              <Download size={18} />
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close"
            title="Close (Esc)"
            onClick={() => registry.set(activeEntryAtom, null)}
          >
            <X size={20} />
          </Button>
        </header>
        <div className="lightbox-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          {entry ? <LightboxMedia key={entry.id} entry={entry} /> : null}
          {files.length > 1 ? (
            <>
              <button
                type="button"
                className="lightbox-nav lightbox-prev"
                aria-label="Previous"
                onClick={() => step(-1)}
              >
                <ChevronLeft size={26} />
              </button>
              <button
                type="button"
                className="lightbox-nav lightbox-next"
                aria-label="Next"
                onClick={() => step(1)}
              >
                <ChevronRight size={26} />
              </button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function LightboxMedia({ entry }: { entry: Entry }) {
  if (entry.previewKind === "video" && entry.contentUrl) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: personal archive media has no caption tracks
      <video
        className="lightbox-media"
        src={entry.contentUrl}
        poster={entry.previewUrl ?? undefined}
        controls
        playsInline
        autoPlay
      />
    )
  }
  if (entry.previewKind === "pdf" && entry.contentUrl) {
    return (
      <iframe className="lightbox-media lightbox-pdf" src={entry.contentUrl} title={entry.name} />
    )
  }
  // Generated previews are static WebP. Unknown WebP uses the original until classified so an
  // existing animation never silently becomes a still image.
  const originalImage =
    entry.mimeType === "image/gif" ||
    (entry.mimeType === "image/webp" && entry.isAnimated !== false)
  const src = originalImage ? entry.contentUrl : (entry.previewUrl ?? entry.contentUrl)
  if (entry.previewKind === "image" && src) {
    return <img className="lightbox-media" src={src} alt={entry.name} draggable={false} />
  }
  return (
    <div className="lightbox-empty">
      <FileIcon size={44} strokeWidth={1.2} />
      <span>No preview for this file</span>
      <Button variant="outline" onClick={() => void actions.download(entry.id)}>
        <Download /> Download
      </Button>
    </div>
  )
}

function MoveDialog({ source }: { source: Entry | null }) {
  const listing = useAtomValue(moveListingAtom)
  const busy = useAtomValue(busyAtom)
  const folders =
    listing?.entries.filter((entry) => entry.kind === "directory" && entry.id !== source?.id) ?? []
  const destinationId = listing?.directory?.id ?? null
  const unchanged = source !== null && destinationId === source.parentId

  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) {
          registry.set(moveSourceAtom, null)
          registry.set(moveListingAtom, null)
        }
      }}
    >
      <DialogContent className="move-dialog">
        <DialogHeader>
          <DialogTitle>Move “{source?.name}”</DialogTitle>
          <DialogDescription>Open the destination folder, then choose Move here.</DialogDescription>
        </DialogHeader>
        <nav className="move-breadcrumb" aria-label="Destination">
          {(listing?.breadcrumbs ?? []).map((crumb, index) => (
            <span key={crumb.id ?? "root"} className="crumb">
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              <button type="button" onClick={() => void actions.browseMove(crumb.id)}>
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="move-folders">
          {folders.length === 0 ? <p className="move-empty">No folders here</p> : null}
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              onClick={() => void actions.browseMove(folder.id)}
            >
              <Folder size={18} /> <span>{folder.name}</span>
              <ChevronRight size={16} className="move-chevron" />
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              registry.set(moveSourceAtom, null)
              registry.set(moveListingAtom, null)
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || unchanged || !listing}
            onClick={() => void actions.confirmMove()}
          >
            Move to {listing?.directory?.name ?? "CloudSync"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}
