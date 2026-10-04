import type { Entry } from "@cloudsync/domain"
import { Link } from "@tanstack/react-router"
import type { AnchorHTMLAttributes } from "react"

export function FolderLink({
  folder,
  recycle = false,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  folder: string | null
  recycle?: boolean
}) {
  return (
    <Link
      to="/"
      search={{ folder: folder ?? undefined, recycle: recycle ? true : undefined }}
      {...props}
    />
  )
}

export function CheckingScreen() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <p className="mb-3.5 text-muted-foreground leading-normal">Opening your archive…</p>
    </main>
  )
}

/** The URL to display an image at full size. */
export function imageSource(entry: Entry): string | null {
  // Generated previews are static WebP. Unknown WebP uses the original until classified so an
  // existing animation never silently becomes a still image.
  const original =
    entry.mimeType === "image/gif" ||
    (entry.mimeType === "image/webp" && entry.isAnimated !== false)
  return original ? entry.contentUrl : (entry.previewUrl ?? entry.contentUrl)
}
