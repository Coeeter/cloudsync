export type PreviewKind = "image" | "video" | "pdf" | "none"

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"])

export function previewKindForMime(mimeType: string | null | undefined): PreviewKind {
  if (!mimeType) return "none"
  if (imageTypes.has(mimeType)) return "image"
  if (mimeType.startsWith("video/")) return "video"
  if (mimeType === "application/pdf") return "pdf"
  return "none"
}
