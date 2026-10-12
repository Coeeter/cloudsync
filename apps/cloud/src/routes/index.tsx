import type { BulkAction, BulkResult, Entry } from "@cloudsync/domain"
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
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@cloudsync/ui/components/input-otp"
import { Progress } from "@cloudsync/ui/components/progress"
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { Exit } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import {
  BookOpen,
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
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react"
import { CheckingScreen, FolderLink, imageSource } from "../client/components"
import {
  activeEntryIdAtom,
  archiveDownloadsAtom,
  bulkAtom,
  createFolderAtom,
  debouncedSearchQueryAtom,
  deletePermanentlyAtom,
  downloadAtom,
  downloadFolder,
  downloadArchiveAtom,
  redownloadArchiveAtom,
  selectionIdsAtom,
  dragActiveAtom,
  errorAtom,
  folderAtom,
  folderViewAtom,
  isReaderImage,
  moveAtom,
  moveFolderAtom,
  moveFolderIdAtom,
  moveSourceAtom,
  mutate,
  newFolderNameAtom,
  newFolderOpenAtom,
  pendingDeleteAtom,
  recycleViewAtom,
  registry,
  renameAtom,
  renameEntryAtom,
  renameValueAtom,
  requestPinAtom,
  restoreAtom,
  retryPreviewAtom,
  searchAtom,
  searchQueryAtom,
  sessionAtom,
  signOut,
  trashAtom,
  type UploadSource,
  uploadAtom,
  uploadProgressAtom,
  verifyPinAtom,
  visit,
} from "../client/state"
import { useAtomValue } from "../client/use-atom"
import { toggleSelection } from "../client/selection"

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    folder: typeof search.folder === "string" && search.folder ? search.folder : undefined,
    recycle: search.recycle === true || search.recycle === "true" ? true : undefined,
  }),
  // The catalog is only reachable with the browser's session cookie.
  ssr: false,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, preload }) => {
    // Hovering or focusing a folder link preloads it without leaving the search results.
    if (!preload) registry.set(searchQueryAtom, "")
    return visit(deps.folder ?? null, deps.recycle === true)
  },
  pendingComponent: CheckingScreen,
  component: CloudSyncApp,
})

function CloudSyncApp() {
  const session = useAtomValue(sessionAtom)
  if (AsyncResult.isSuccess(session)) return <FileBrowser />
  if (AsyncResult.isInitial(session)) return <CheckingScreen />
  return <SignIn />
}

function SignIn() {
  const router = useRouter()
  const requestPin = useAtomValue(requestPinAtom)
  const verifyPin = useAtomValue(verifyPinAtom)
  const busy = requestPin.waiting || verifyPin.waiting
  const error = useAtomValue(errorAtom)
  const [view, setView] = useState<"email" | "pin">("email")
  const [savedEmail, setSavedEmail] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [code, setCode] = useState("")

  const sendPin = (email: string, sentNotice: string | null) =>
    mutate(requestPinAtom, email).then((exit) => {
      if (Exit.isFailure(exit)) return
      setSavedEmail(email)
      setNotice(sentNotice)
      setCode("")
      setView("pin")
    })

  const submitEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim()
    if (email) void sendPin(email, null)
  }

  const submitCode = (value: string) => {
    if (value.length !== 6 || busy) return
    void mutate(verifyPinAtom, { email: savedEmail, code: value }).then((exit) => {
      if (Exit.isSuccess(exit)) void router.invalidate()
    })
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="w-full max-w-sm">
        <h1 className="mb-2 text-3xl font-semibold tracking-tighter">CloudSync</h1>
        {view === "email" ? (
          <form key="email" className="grid gap-3" onSubmit={submitEmail}>
            <p className="mb-3.5 text-muted-foreground leading-normal">
              Enter the owner email to receive a sign-in code.
            </p>
            <Input
              type="email"
              name="email"
              autoComplete="email"
              defaultValue={savedEmail}
              placeholder="you@example.com"
              required
              autoFocus
            />
            {error ? <p className="m-0 text-sm text-destructive">{error}</p> : null}
            <Button disabled={busy}>{busy ? "Sending…" : "Send code"}</Button>
          </form>
        ) : (
          <form
            key="pin"
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              submitCode(code)
            }}
          >
            <p className="mb-3.5 text-muted-foreground leading-normal">
              Enter the six-digit code sent to{" "}
              <strong className="break-all font-[540] text-foreground">{savedEmail}</strong>.
            </p>
            <InputOTP
              name="code"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={setCode}
              onComplete={submitCode}
              required
              autoFocus
              pattern="[0-9]*"
              containerClassName="w-full"
            >
              <InputOTPGroup className="w-full">
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <InputOTPSlot
                    className="h-12 flex-1 font-mono text-xl"
                    index={index}
                    key={index}
                  />
                ))}
              </InputOTPGroup>
            </InputOTP>
            {error ? <p className="m-0 text-sm text-destructive">{error}</p> : null}
            {notice ? <p className="m-0 text-sm text-muted-foreground">{notice}</p> : null}
            <Button disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Open archive"}
            </Button>
            <div className="flex justify-between gap-3">
              <button
                className="border-0 bg-transparent px-0 py-1 text-sm text-muted-foreground hover:not-disabled:text-foreground"
                type="button"
                onClick={() => {
                  registry.set(errorAtom, null)
                  setNotice(null)
                  setView("email")
                }}
                disabled={busy}
              >
                Use a different email
              </button>
              <button
                className="border-0 bg-transparent px-0 py-1 text-sm text-muted-foreground hover:not-disabled:text-foreground"
                type="button"
                onClick={() => void sendPin(savedEmail, "A new code was sent.")}
                disabled={busy}
              >
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
  const folder = location.folder ?? null
  const view = location.recycle ? "recycle" : "files"
  const current = useAtomValue(
    view === "recycle" ? recycleViewAtom(folder) : folderViewAtom(folder),
  )
  const query = useAtomValue(searchQueryAtom)
  const debouncedQuery = useAtomValue(debouncedSearchQueryAtom)
  const search = useAtomValue(searchAtom)
  const error = useAtomValue(errorAtom)
  const progress = useAtomValue(uploadProgressAtom)
  const dragActive = useAtomValue(dragActiveAtom)
  const activeEntryId = useAtomValue(activeEntryIdAtom)
  const moveSource = useAtomValue(moveSourceAtom)
  const newFolderOpen = useAtomValue(newFolderOpenAtom)
  const newFolderName = useAtomValue(newFolderNameAtom)
  const renameEntry = useAtomValue(renameEntryAtom)
  const renameValue = useAtomValue(renameValueAtom)
  const pendingDelete = useAtomValue(pendingDeleteAtom)
  const sentinel = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [selection, setSelection] = useState<{ scope: string; ids: ReadonlySet<string> }>({
    scope: "",
    ids: new Set(),
  })
  const [selectingAll, setSelectingAll] = useState(false)
  const [bulkMove, setBulkMove] = useState<ReadonlyArray<string> | null>(null)
  const [bulkDelete, setBulkDelete] = useState<{
    ids: ReadonlyArray<string>
    action: "trash" | "delete"
  } | null>(null)
  const anchor = useRef<{ scope: string; id: string } | null>(null)
  const scope = JSON.stringify([view, folder, query.trim()])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const selected = selection.scope === scope ? selection.ids : new Set<string>()
  const bulkBusy = useAtomValue(bulkAtom).waiting
  const downloads = useAtomValue(archiveDownloadsAtom)

  const upload = (source: UploadSource) => void mutate(uploadAtom, { parentId: folder, source })

  const uploadInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }))
    event.target.value = ""
    if (files.length > 0) upload(files)
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
    if (canDrop) upload(event.dataTransfer.items)
  }

  const searching = view === "files" && query.trim().length > 0
  const searchResponse = AsyncResult.getOrElse(search, () => null)
  const searchResults = searchResponse?.results ?? []
  const searchTruncated = searchResponse?.truncated ?? false
  const searchLoading = searching && (search.waiting || debouncedQuery !== query)
  const entries = searching ? searchResults.map((result) => result.entry) : current.entries
  const searchPathById = new Map(
    searchResults.map((result) => [result.entry.id, result.parentPath]),
  )
  const recycleMode = view === "recycle" ? (folder === null ? "root" : "nested") : null
  const hasMore = view === "files" && !searching && current.hasMore
  const loadingMore = hasMore && current.waiting
  const activeEntry = entries.find((entry) => entry.id === activeEntryId) ?? null
  const canSelect = recycleMode !== "nested"
  const toggle = (id: string, range: boolean) => {
    setSelection({
      scope,
      ids: toggleSelection(
        selected,
        id,
        entries.map((entry) => entry.id),
        anchor.current?.scope === scope ? anchor.current.id : null,
        range,
      ),
    })
    anchor.current = { scope, id }
  }
  const clearSelection = () => setSelection({ scope, ids: new Set() })
  const selectAll = async () => {
    if (!canSelect || selectingAll) return
    setSelectingAll(true)
    try {
      const result = await mutate(selectionIdsAtom, {
        parentId: folder,
        query: searching ? query : undefined,
        trashed: view === "recycle",
      })
      if (Exit.isSuccess(result) && scopeRef.current === scope)
        setSelection({ scope, ids: new Set(result.value) })
    } finally {
      setSelectingAll(false)
    }
  }
  const bulkResult = (result: BulkResult) => {
    if (scopeRef.current === scope)
      setSelection({ scope, ids: new Set(result.failed.map((item) => item.id)) })
    if (result.failed.length)
      registry.set(
        errorAtom,
        `${result.failed.length} item${result.failed.length === 1 ? "" : "s"} failed: ${result.failed[0]?.message}`,
      )
  }
  const runBulk = async (ids: ReadonlyArray<string>, action: BulkAction) => {
    const result = await mutate(bulkAtom, { ids, action })
    if (Exit.isSuccess(result)) bulkResult(result.value)
  }
  const selectionKeys = useRef({ selectAll, clearSelection })
  selectionKeys.current = { selectAll, clearSelection }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !canSelect ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            "input, textarea, [contenteditable], [role=dialog], [role=alertdialog]",
          ))
      )
        return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault()
        void selectionKeys.current.selectAll()
      } else if (event.key === "Escape") selectionKeys.current.clearSelection()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [canSelect])

  // Re-observing after every page makes the observer fire again while the sentinel is still
  // on screen, so tall viewports keep filling instead of stalling after one page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: entries.length intentionally re-arms the observer
  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore || current.waiting) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting))
          registry.set(folderAtom(folder), undefined)
      },
      { rootMargin: "1200px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, current.waiting, folder, current.entries.length])

  return (
    <main
      className="min-h-screen px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-16 sm:px-6 lg:px-12"
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        if (carriesFiles(event)) event.preventDefault()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="sticky top-0 z-20 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 bg-[linear-gradient(var(--carbon)_72%,transparent)] pt-2.5 pb-5 max-sm:grid-cols-1 max-sm:gap-2">
        <nav
          className="flex min-w-0 items-center gap-2 overflow-hidden text-base text-muted-foreground lg:text-lg [&_a]:overflow-hidden [&_a]:border-0 [&_a]:bg-transparent [&_a]:px-px [&_a]:py-1 [&_a]:text-inherit [&_a]:text-ellipsis [&_a]:whitespace-nowrap [&_a:hover]:text-foreground [&_a[aria-current=page]]:font-semibold [&_a[aria-current=page]]:text-foreground"
          aria-label="Current folder"
        >
          {view === "recycle" ? (
            <>
              <FolderLink folder={null}>CloudSync</FolderLink>
              {current.breadcrumbs.map((crumb, index, crumbs) => (
                <span
                  key={crumb.id ?? "recycle"}
                  className="inline-flex min-w-0 items-center gap-2"
                >
                  <span aria-hidden="true">/</span>
                  <FolderLink
                    folder={crumb.id}
                    recycle
                    aria-current={index === crumbs.length - 1 ? "page" : undefined}
                  >
                    {crumb.name}
                  </FolderLink>
                </span>
              ))}
            </>
          ) : (
            current.breadcrumbs.map((crumb, index, crumbs) => (
              <span key={crumb.id ?? "root"} className="inline-flex min-w-0 items-center gap-2">
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                <FolderLink
                  folder={crumb.id}
                  aria-current={index === crumbs.length - 1 ? "page" : undefined}
                >
                  {crumb.name}
                </FolderLink>
              </span>
            ))
          )}
        </nav>
        <div className="flex items-center gap-2 max-sm:justify-between">
          {view === "files" ? (
            <>
              <div className="relative max-sm:flex-1">
                <Search
                  className="pointer-events-none absolute top-3 left-3 text-muted-foreground"
                  size={16}
                  strokeWidth={1.8}
                />
                <Input
                  className="h-10 w-40 rounded-lg border-transparent bg-card pr-10 pl-10 text-foreground focus-visible:border-ring sm:w-56 lg:w-80 max-sm:w-full"
                  value={query}
                  onChange={(event) => registry.set(searchQueryAtom, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") registry.set(searchQueryAtom, "")
                  }}
                  placeholder="Search names and paths"
                  aria-label="Search archive"
                />
                {query ? (
                  <button
                    type="button"
                    className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Clear search"
                    onClick={() => registry.set(searchQueryAtom, "")}
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
              {folder !== null && !searching && current.entries.some(isReaderImage) ? (
                <Button asChild variant="ghost">
                  <Link to="/reader/$folderId" params={{ folderId: folder }}>
                    <BookOpen size={16} />
                    <span className="max-sm:hidden">Reader</span>
                  </Link>
                </Button>
              ) : null}
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
                <span className="max-sm:hidden">Upload</span>
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
                <DropdownMenuItem asChild>
                  <FolderLink folder={null} recycle>
                    <Trash2 /> Recycle Bin
                  </FolderLink>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem asChild>
                  <FolderLink folder={null}>
                    <Folder /> Back to files
                  </FolderLink>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void signOut()}>
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

      {canSelect && entries.length > 0 ? (
        <section
          className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2"
          aria-label="Selection actions"
        >
          <span className="mr-auto text-sm text-muted-foreground" aria-live="polite">
            {selected.size ? `${selected.size} selected` : "Select files and folders"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={selectingAll || bulkBusy || searchLoading}
            onClick={() => void selectAll()}
          >
            {selectingAll ? "Selecting…" : "Select all"}
          </Button>
          {selected.size > 0 ? (
            <>
              <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={clearSelection}>
                Deselect all
              </Button>
              {view === "files" ? (
                <>
                  <Button size="sm" onClick={() => void mutate(downloadArchiveAtom, [...selected])}>
                    <Download size={15} /> Download ZIP
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={bulkBusy}
                    onClick={() => {
                      registry.set(moveFolderIdAtom, folder)
                      setBulkMove([...selected])
                    }}
                  >
                    <Move size={15} /> Move
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={bulkBusy}
                    onClick={() => setBulkDelete({ ids: [...selected], action: "trash" })}
                  >
                    <Trash2 size={15} /> Move to trash
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={bulkBusy}
                    onClick={() => void runBulk([...selected], "restore")}
                  >
                    <RotateCcw size={15} /> Restore
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={bulkBusy}
                    onClick={() => setBulkDelete({ ids: [...selected], action: "delete" })}
                  >
                    <Trash2 size={15} /> Delete permanently
                  </Button>
                </>
              )}
            </>
          ) : null}
        </section>
      ) : null}

      {downloads.map((download) => (
        <div
          key={download.id}
          className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm"
          aria-live="polite"
        >
          <FileArchive size={18} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate font-medium">{download.name}</p>
            <p
              className={`m-0 text-xs ${download.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {download.status === "completed"
                ? "ZIP ready · download started"
                : download.status === "failed"
                  ? download.error
                  : download.status === "pending"
                    ? "Waiting to prepare ZIP…"
                    : download.status === "uploading"
                      ? "Finishing ZIP upload…"
                      : `Preparing ZIP · ${download.processed}/${download.total} files`}
            </p>
            {download.status === "building" ? (
              <Progress
                className="mt-2 h-1"
                value={download.total ? (download.processed / download.total) * 100 : 0}
              />
            ) : null}
          </div>
          {download.status === "completed" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void mutate(redownloadArchiveAtom, download.id)}
            >
              Download again
            </Button>
          ) : null}
          {download.status === "completed" || download.status === "failed" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Dismiss ${download.name}`}
              onClick={() =>
                registry.update(archiveDownloadsAtom, (items) =>
                  items.filter((item) => item.id !== download.id),
                )
              }
            >
              <X size={14} />
            </Button>
          ) : null}
        </div>
      ))}

      {(error ?? current.error) ? (
        <div
          className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm leading-normal text-destructive"
          role="alert"
        >
          <span>{error ?? current.error}</span>
          <button
            className="shrink-0 border-0 bg-transparent p-0.5 text-inherit"
            type="button"
            aria-label="Dismiss"
            onClick={() => registry.set(errorAtom, null)}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      {progress ? (
        <div className="mb-4 grid max-w-sm gap-2 text-xs text-muted-foreground" aria-live="polite">
          <span>
            Uploading {progress.done + progress.failed} of {progress.total}
            {progress.failed > 0 ? ` · ${progress.failed} failed` : ""}
          </span>
          <Progress value={((progress.done + progress.failed) / progress.total) * 100} />
        </div>
      ) : null}
      {recycleMode === "root" ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Items here are permanently deleted after 30 days.
        </p>
      ) : null}
      {recycleMode === "nested" ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Viewing a deleted folder. Restore it from the Recycle Bin to bring it back.
        </p>
      ) : null}
      {searching ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {searchLoading
            ? `Searching for “${query.trim()}”…`
            : `${searchResults.length}${searchTruncated ? "+" : ""} result${searchResults.length === 1 && !searchTruncated ? "" : "s"} for “${query.trim()}”${searchTruncated ? " · showing the first 100" : ""}`}
        </p>
      ) : null}

      {entries.length > 0 ? (
        <section
          className="grid grid-cols-2 items-start gap-x-3 gap-y-4 sm:grid-cols-4 sm:gap-x-4 lg:grid-cols-6 lg:gap-x-6 lg:gap-y-7 2xl:grid-cols-8"
          aria-label={searching ? "Search results" : "Folder contents"}
        >
          {entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              recycle={recycleMode}
              searchPath={searching ? searchPathById.get(entry.id) : undefined}
              selected={selected.has(entry.id)}
              selecting={selected.size > 0}
              onToggle={canSelect ? (range) => toggle(entry.id, range) : undefined}
            />
          ))}
        </section>
      ) : (
        <section className="grid min-h-[55vh] place-items-center text-center text-muted-foreground">
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
                    : current.loaded
                      ? "Drop files here or upload a folder"
                      : "Loading…"}
            </p>
          </div>
        </section>
      )}

      {hasMore ? (
        <div
          ref={sentinel}
          className="grid min-h-16 place-items-center text-sm text-muted-foreground"
          aria-live="polite"
        >
          {loadingMore ? "Loading more…" : null}
        </div>
      ) : null}

      {dragActive ? (
        <div className="pointer-events-none fixed inset-4 z-50 grid place-items-center rounded-xl border-2 border-ring bg-[rgba(11,12,14,0.9)] text-xl text-foreground">
          Add to {current.directory?.name ?? "CloudSync"}
        </div>
      ) : null}
      <NewFolderDialog open={newFolderOpen} name={newFolderName} parentId={folder} />
      <RenameDialog entry={renameEntry} value={renameValue} />
      <DeleteDialog pending={pendingDelete} />
      <Lightbox entry={activeEntry} entries={entries} />
      <MoveDialog source={moveSource} />
      <Dialog
        open={bulkMove !== null}
        onOpenChange={(open) => {
          if (!open) setBulkMove(null)
        }}
      >
        <DialogContent className="gap-3">
          {bulkMove ? (
            <MovePicker
              source={null}
              ids={bulkMove}
              onBulkResult={bulkResult}
              close={() => setBulkMove(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={bulkDelete !== null}
        onOpenChange={(open) => {
          if (!open) setBulkDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkDelete?.action === "delete"
                ? "Delete selected items permanently?"
                : "Move selected items to trash?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkDelete?.ids.length ?? 0} selected items and their contents{" "}
              {bulkDelete?.action === "delete"
                ? "cannot be recovered after this."
                : "stay recoverable for 30 days."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (bulkDelete) void runBulk(bulkDelete.ids, bulkDelete.action)
                setBulkDelete(null)
              }}
            >
              {bulkDelete?.action === "delete" ? "Delete permanently" : "Move to trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

function EntryCard({
  entry,
  recycle,
  searchPath,
  selected = false,
  selecting = false,
  onToggle,
}: {
  entry: Entry
  recycle: "root" | "nested" | null
  searchPath?: string
  selected?: boolean
  selecting?: boolean
  onToggle?: (range: boolean) => void
}) {
  const [broken, setBroken] = useState(false)
  const fallback =
    entry.kind === "directory" ? (
      <Folder className="text-amber-300" size={52} strokeWidth={1.25} />
    ) : entry.previewKind === "image" ? (
      <ImageIcon className="text-[#6c727d]" size={40} strokeWidth={1.2} />
    ) : entry.previewKind === "video" ? (
      <Video className="text-[#6c727d]" size={40} strokeWidth={1.2} />
    ) : entry.previewKind === "pdf" ? (
      <FileText className="text-[#6c727d]" size={40} strokeWidth={1.2} />
    ) : entry.mimeType?.includes("zip") ? (
      <FileArchive className="text-[#6c727d]" size={40} strokeWidth={1.2} />
    ) : (
      <FileIcon className="text-[#6c727d]" size={40} strokeWidth={1.2} />
    )

  const cardClass =
    "group block w-full border-0 bg-transparent p-0 text-left text-inherit outline-none"
  const onCardClick = (event: MouseEvent<HTMLElement>) => {
    if (onToggle && (selecting || event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault()
      onToggle(event.shiftKey)
    } else if (entry.kind === "file") registry.set(activeEntryIdAtom, entry.id)
  }
  const card = (
    <>
      <div
        className={
          entry.kind === "directory"
            ? "relative grid aspect-square place-items-center overflow-hidden rounded-lg border border-amber-300/40 bg-amber-950/20 p-2 ring-1 ring-amber-300/10 ring-inset before:absolute before:top-0 before:right-0 before:z-[2] before:h-[13%] before:w-[36%] before:origin-top-right before:translate-x-2 before:skew-x-[-24deg] before:border-b before:border-l before:border-amber-300/40 before:bg-amber-950 group-focus-visible:ring-2 group-focus-visible:ring-amber-300"
            : "relative grid aspect-square place-items-center overflow-hidden rounded-lg border border-border bg-[#111317] group-focus-visible:ring-2 group-focus-visible:ring-ring"
        }
      >
        {entry.thumbnailUrl && !broken ? (
          <img
            className={
              entry.kind === "directory"
                ? "size-full rounded-sm object-contain opacity-85"
                : "size-full object-contain"
            }
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
          <span className="absolute right-2 bottom-2 grid size-6 place-items-center rounded-md bg-[rgba(11,12,14,0.72)] text-foreground">
            <Video size={12} />
          </span>
        ) : null}
        {entry.kind === "directory" ? (
          <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-amber-300 px-2 py-1 text-xs font-semibold text-amber-950 shadow-sm">
            <Folder size={13} fill="currentColor" /> Folder
          </span>
        ) : null}
        {entry.kind === "file" &&
        entry.previewStatus !== "ready" &&
        entry.previewKind !== "none" ? (
          <span
            className={
              entry.previewStatus === "failed"
                ? "absolute right-2 bottom-2 rounded-sm border border-destructive/45 bg-[rgba(11,12,14,0.82)] px-1.5 py-1 text-xs text-destructive"
                : "absolute right-2 bottom-2 rounded-sm border border-[rgba(243,241,235,0.14)] bg-[rgba(11,12,14,0.82)] px-1.5 py-1 text-xs text-muted-foreground"
            }
          >
            {entry.previewStatus === "failed" ? "Preview failed" : "Processing preview"}
          </span>
        ) : null}
      </div>
      <div className="grid gap-0.5 pt-2 pr-8 pl-0.5">
        <span
          className={`overflow-hidden text-sm font-medium text-ellipsis whitespace-nowrap ${entry.kind === "directory" ? "text-amber-100" : ""}`}
        >
          {entry.name}
        </span>
        {searchPath ? (
          <span className="overflow-hidden text-xs text-muted-foreground text-ellipsis whitespace-nowrap">
            {searchPath}
          </span>
        ) : null}
        <span className="font-mono text-xs text-muted-foreground">
          {entry.kind === "directory"
            ? `${entry.childCount} item${entry.childCount === 1 ? "" : "s"}`
            : formatBytes(entry.size)}
        </span>
      </div>
    </>
  )

  return (
    <article
      className={`group/card relative min-w-0 rounded-lg ${selected ? "ring-2 ring-ring ring-offset-4 ring-offset-background" : ""}`}
    >
      {onToggle ? (
        <input
          type="checkbox"
          checked={selected}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(event.shiftKey)
          }}
          onChange={() => undefined}
          aria-label={`Select ${entry.name}`}
          className={`absolute top-2 left-2 z-10 size-5 cursor-pointer accent-[var(--ring)] ${selecting ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100 sm:focus-visible:opacity-100"}`}
        />
      ) : null}
      {entry.kind === "directory" ? (
        <FolderLink
          folder={entry.id}
          recycle={recycle !== null}
          className={cardClass}
          title={entry.name}
          onClick={onCardClick}
        >
          {card}
        </FolderLink>
      ) : (
        <button type="button" className={cardClass} onClick={onCardClick} title={entry.name}>
          {card}
        </button>
      )}
      {recycle === "nested" ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="absolute -right-1 bottom-0.5 grid size-7 place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-card hover:text-foreground"
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
                <DropdownMenuItem onSelect={() => void mutate(restoreAtom, entry.id)}>
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
                    <DropdownMenuItem onSelect={() => void mutate(downloadAtom, entry.id)}>
                      <Download /> Download
                    </DropdownMenuItem>
                    {entry.previewStatus === "failed" ? (
                      <DropdownMenuItem onSelect={() => void mutate(retryPreviewAtom, entry)}>
                        <RotateCcw /> Retry preview
                      </DropdownMenuItem>
                    ) : null}
                  </>
                ) : (
                  <DropdownMenuItem onSelect={() => downloadFolder(entry.id)}>
                    <Download /> Download ZIP
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() => {
                    registry.set(renameEntryAtom, entry)
                    registry.set(renameValueAtom, entry.name)
                  }}
                >
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    registry.set(moveFolderIdAtom, entry.parentId)
                    registry.set(moveSourceAtom, entry)
                  }}
                >
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

function NewFolderDialog({
  open,
  name,
  parentId,
}: {
  open: boolean
  name: string
  parentId: string | null
}) {
  const busy = useAtomValue(createFolderAtom).waiting
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
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim()) return
            void mutate(createFolderAtom, { parentId, name: name.trim() }).then((exit) => {
              if (Exit.isFailure(exit)) return
              registry.set(newFolderOpenAtom, false)
              registry.set(newFolderNameAtom, "")
            })
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
  const busy = useAtomValue(renameAtom).waiting
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) registry.set(renameEntryAtom, null)
      }}
    >
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!entry || !value.trim() || value.trim() === entry.name) {
              registry.set(renameEntryAtom, null)
              return
            }
            void mutate(renameAtom, { id: entry.id, name: value.trim() }).then((exit) => {
              if (Exit.isSuccess(exit)) registry.set(renameEntryAtom, null)
            })
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
              const atom = pending.permanent ? deletePermanentlyAtom : trashAtom
              void mutate(atom, pending.entry.id).then((exit) => {
                if (Exit.isFailure(exit)) return
                registry.set(pendingDeleteAtom, null)
                registry.set(activeEntryIdAtom, null)
              })
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
    registry.set(
      activeEntryIdAtom,
      files[(index + offset + files.length) % files.length]?.id ?? null,
    )
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
        if (!open) registry.set(activeEntryIdAtom, null)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-[#050506] p-0 text-foreground shadow-none sm:max-w-none"
      >
        <header className="absolute top-0 right-0 left-0 z-[3] flex items-center gap-1 bg-[linear-gradient(rgba(0,0,0,0.72),transparent)] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-7">
          <div className="grid min-w-0 flex-1 gap-0.5">
            <DialogTitle className="overflow-hidden text-sm font-[560] text-ellipsis whitespace-nowrap">
              {entry?.name}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs text-muted-foreground">
              {entry ? formatBytes(entry.size) : ""}
              {files.length > 1 && index >= 0 ? ` · ${index + 1} / ${files.length}` : ""}
              {entry?.previewStatus === "failed" ? " · preview failed" : ""}
            </DialogDescription>
          </div>
          {entry ? (
            entry.previewStatus === "failed" ? (
              <Button variant="ghost" onClick={() => void mutate(retryPreviewAtom, entry)}>
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
              onClick={() => void mutate(downloadAtom, entry.id)}
            >
              <Download size={18} />
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close"
            title="Close (Esc)"
            onClick={() => registry.set(activeEntryIdAtom, null)}
          >
            <X size={20} />
          </Button>
        </header>
        <div
          className="relative min-h-0 flex-1 touch-pan-y select-none"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          {entry ? <LightboxMedia key={entry.id} entry={entry} /> : null}
          {files.length > 1 ? (
            <>
              <button
                type="button"
                className="absolute top-1/2 left-3.5 z-[2] grid size-12 -translate-y-1/2 place-items-center rounded-full border-0 bg-[rgba(20,22,26,0.6)] text-foreground opacity-70 hover:opacity-100 focus-visible:opacity-100 max-sm:hidden"
                aria-label="Previous"
                onClick={() => step(-1)}
              >
                <ChevronLeft size={26} />
              </button>
              <button
                type="button"
                className="absolute top-1/2 right-3.5 z-[2] grid size-12 -translate-y-1/2 place-items-center rounded-full border-0 bg-[rgba(20,22,26,0.6)] text-foreground opacity-70 hover:opacity-100 focus-visible:opacity-100 max-sm:hidden"
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
      <div className="absolute inset-x-4 top-16 bottom-4 flex items-center justify-center max-sm:inset-x-0 max-sm:bottom-0">
        {/* biome-ignore lint/a11y/useMediaCaption: personal archive media has no caption tracks */}
        <video
          className="max-h-full max-w-full object-contain"
          src={entry.contentUrl}
          poster={entry.previewUrl ?? undefined}
          controls
          playsInline
          autoPlay
        />
      </div>
    )
  }
  if (entry.previewKind === "pdf" && entry.contentUrl) {
    return (
      <div className="absolute inset-x-4 top-16 bottom-4 max-sm:inset-x-0 max-sm:bottom-0">
        <iframe
          className="size-full rounded-md border-0 bg-foreground"
          src={entry.contentUrl}
          title={entry.name}
        />
      </div>
    )
  }
  const src = imageSource(entry)
  if (entry.previewKind === "image" && src) {
    return (
      <div className="absolute inset-x-4 top-16 bottom-4 flex items-center justify-center max-sm:inset-x-0 max-sm:bottom-0">
        <img
          className="max-h-full max-w-full object-contain"
          src={src}
          alt={entry.name}
          draggable={false}
        />
      </div>
    )
  }
  return (
    <div className="absolute inset-0 grid place-content-center justify-items-center gap-3.5 text-muted-foreground">
      <FileIcon size={44} strokeWidth={1.2} />
      <span>No preview for this file</span>
      <Button variant="outline" onClick={() => void mutate(downloadAtom, entry.id)}>
        <Download /> Download
      </Button>
    </div>
  )
}

function MoveDialog({ source }: { source: Entry | null }) {
  const close = () => registry.set(moveSourceAtom, null)
  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="gap-3">
        {source ? <MovePicker source={source} close={close} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function MovePicker({
  source,
  close,
  ids,
  onBulkResult,
}: {
  source: Entry | null
  close: () => void
  ids?: ReadonlyArray<string>
  onBulkResult?: (result: BulkResult) => void
}) {
  const folderId = useAtomValue(moveFolderIdAtom)
  const result = useAtomValue(moveFolderAtom(folderId))
  const singleBusy = useAtomValue(moveAtom).waiting
  const bulkBusy = useAtomValue(bulkAtom).waiting
  const busy = ids ? bulkBusy : singleBusy
  const listing = AsyncResult.getOrElse(result, () => null)
  const folders =
    listing?.entries.filter(
      (entry) => entry.kind === "directory" && entry.id !== source?.id && !ids?.includes(entry.id),
    ) ?? []
  const unchanged = source !== null && folderId === source.parentId
  const browse = (id: string | null) => registry.set(moveFolderIdAtom, id)

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {source ? `Move “${source.name}”` : `Move ${ids?.length ?? 0} selected items`}
        </DialogTitle>
        <DialogDescription>Open the destination folder, then choose Move here.</DialogDescription>
      </DialogHeader>
      <nav
        className="flex gap-1.5 overflow-x-auto border-b border-border px-0.5 py-2 text-sm whitespace-nowrap text-muted-foreground [&_a]:border-0 [&_a]:bg-transparent [&_a]:p-0 [&_a]:text-inherit [&>span:last-child_button]:font-semibold [&>span:last-child_button]:text-foreground"
        aria-label="Destination"
      >
        {(listing?.breadcrumbs ?? []).map((crumb, index) => (
          <span key={crumb.id ?? "root"} className="inline-flex min-w-0 items-center gap-2">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            <button type="button" onClick={() => browse(crumb.id)}>
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="grid min-h-52 max-h-[46vh] content-start overflow-y-auto [&>button]:flex [&>button]:items-center [&>button]:gap-2.5 [&>button]:rounded-md [&>button]:border-0 [&>button]:bg-transparent [&>button]:p-2.5 [&>button]:text-left [&>button]:text-foreground [&>button:hover]:bg-card [&>button_span]:flex-1 [&>button_span]:overflow-hidden [&>button_span]:text-ellipsis [&>button_span]:whitespace-nowrap">
        {listing && folders.length === 0 ? (
          <p className="m-0 px-2.5 py-6 text-center text-sm text-muted-foreground">
            No folders here
          </p>
        ) : null}
        {folders.map((folder) => (
          <button key={folder.id} type="button" onClick={() => browse(folder.id)}>
            <Folder size={18} /> <span>{folder.name}</span>
            <ChevronRight size={16} className="text-muted-foreground" />
          </button>
        ))}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button
          disabled={busy || unchanged || !listing}
          onClick={() => {
            if (ids)
              void mutate(bulkAtom, { ids, action: "move", parentId: folderId }).then((exit) => {
                if (Exit.isSuccess(exit)) {
                  onBulkResult?.(exit.value)
                  close()
                }
              })
            else if (source)
              void mutate(moveAtom, { id: source.id, parentId: folderId }).then((exit) => {
                if (Exit.isSuccess(exit)) close()
              })
          }}
        >
          Move to {listing?.directory?.name ?? "CloudSync"}
        </Button>
      </DialogFooter>
    </>
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
