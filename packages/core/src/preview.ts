export type PreviewKind = "image" | "video" | "pdf" | "none"

export const previewSettings = {
  version: 1,
  thumbnail: { size: 480, quality: 78 },
  preview: { size: 2200, quality: 86 },
} as const

export function uploadedPreviewKeys(uploadId: string) {
  return {
    thumbnail: `previews/uploads/${uploadId}/thumbnail.webp`,
    preview: `previews/uploads/${uploadId}/preview.webp`,
  }
}

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"])

export function previewKindForMime(mimeType: string | null | undefined): PreviewKind {
  if (!mimeType) return "none"
  if (imageTypes.has(mimeType)) return "image"
  if (mimeType.startsWith("video/")) return "video"
  if (mimeType === "application/pdf") return "pdf"
  return "none"
}
