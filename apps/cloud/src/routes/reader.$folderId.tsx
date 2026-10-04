import type { Entry } from "@cloudsync/domain"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { AsyncResult } from "effect/unstable/reactivity"
import { ArrowLeft } from "lucide-react"
import { useEffect, useState } from "react"
import { CheckingScreen, FolderLink, imageSource } from "../client/components"
import { loadReader, readerAtom } from "../client/state"
import { useAtomValue } from "../client/use-atom"

export const Route = createFileRoute("/reader/$folderId")({
  // The catalog is only reachable with the browser's session cookie.
  ssr: false,
  loader: async ({ params }) => {
    const reader = await loadReader(params.folderId)
    if (!reader || reader.images.length === 0) {
      throw redirect({ to: "/", search: { folder: params.folderId, recycle: undefined } })
    }
  },
  pendingComponent: CheckingScreen,
  component: ReaderPage,
})

function ReaderPage() {
  const { folderId } = Route.useParams()
  const reader = AsyncResult.getOrElse(useAtomValue(readerAtom(folderId)), () => null)
  if (!reader) return <CheckingScreen />
  const { directory, images } = reader

  return (
    <main className="min-h-screen pb-16">
      <ReaderKeyboard />
      <header className="mx-auto max-w-6xl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 sm:px-6 sm:pb-8">
        <FolderLink
          folder={folderId}
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> Back to folder
        </FolderLink>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {directory?.name ?? "Reader"}
        </h1>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {images.length} page{images.length === 1 ? "" : "s"}
        </p>
      </header>
      <div className="relative mx-auto max-w-3xl overflow-clip bg-[#050506]">
        <PagingZones />
        {images.map((entry, index) => (
          <ReaderImage key={entry.id} entry={entry} index={index} />
        ))}
      </div>
      <div className="mx-auto mt-10 max-w-3xl px-4 text-center">
        <FolderLink
          folder={folderId}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> Back to {directory?.name ?? "folder"}
        </FolderLink>
      </div>
    </main>
  )
}

/** Matches the worker's preview resize bound. */
const previewLongEdge = 2200

function ReaderImage({ entry, index }: { entry: Entry; index: number }) {
  const [src, setSrc] = useState(() => imageSource(entry))
  const [loaded, setLoaded] = useState(false)

  return (
    <div className={loaded ? "relative" : "relative aspect-[2/3] animate-pulse bg-card"}>
      <img
        data-reader-page
        className={loaded ? "block h-auto w-full" : "absolute inset-0 size-full opacity-0"}
        src={src ?? undefined}
        alt={`Page ${index + 1}`}
        draggable={false}
        loading={index < 3 ? "eager" : "lazy"}
        decoding="async"
        onLoad={(event) => {
          const image = event.currentTarget
          // Previews are capped at 2200px on the long edge, so a tall strip that hit the cap comes
          // back too narrow for the column; those switch to the original.
          const capped = Math.max(image.naturalWidth, image.naturalHeight) >= previewLongEdge
          const needed = image.clientWidth * window.devicePixelRatio * 0.75
          if (
            capped &&
            image.naturalWidth < needed &&
            entry.contentUrl &&
            src !== entry.contentUrl
          ) {
            setSrc(entry.contentUrl)
          }
          setLoaded(true)
        }}
      />
    </div>
  )
}

/*
 * Pixiv-style paging for a mouse: the top fifth of the screen pages back and the bottom two fifths
 * forward, a screen at a time. The zones are pinned to the viewport rather than to an image, so a
 * step never skips the bottom of a tall page or crawls through short ones.
 */
function PagingZones() {
  return (
    <div aria-hidden="true" className="sticky top-0 z-10 hidden h-0 pointer-fine:block">
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: mouse-only shortcut; the arrow keys page for keyboard users */}
      <div
        className="absolute inset-x-0 top-0 h-[20vh]"
        style={{ cursor: pageUpCursor }}
        onClick={() => pageByScreen(-1)}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: mouse-only shortcut; the arrow keys page for keyboard users */}
      <div
        className="absolute inset-x-0 top-[60vh] h-[40vh]"
        style={{ cursor: pageDownCursor }}
        onClick={() => pageByScreen(1)}
      />
    </div>
  )
}

const pageByScreen = (direction: 1 | -1) =>
  window.scrollBy({ top: direction * (window.innerHeight - 96), behavior: "smooth" })

const pageCursor = (path: string, fallback: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="rgba(0,0,0,0.55)" stroke="white" stroke-width="1.5"/><path d="${path}" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  )}") 20 20, ${fallback}`

const pageUpCursor = pageCursor("M12 23l8-8 8 8", "n-resize")
const pageDownCursor = pageCursor("M12 17l8 8 8-8", "s-resize")

/** Left and right arrows jump to the previous or next page's top edge. */
function ReaderKeyboard() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      const tops = Array.from(document.querySelectorAll("[data-reader-page]"), (page) =>
        Math.round(page.getBoundingClientRect().top),
      )
      const target =
        event.key === "ArrowRight" ? tops.find((top) => top > 1) : tops.findLast((top) => top < -1)
      if (target !== undefined) window.scrollBy({ top: target, behavior: "smooth" })
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
  return null
}
