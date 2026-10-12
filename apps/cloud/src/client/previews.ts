import { isAnimatedWebP, previewKindForMime, previewSettings } from "@cloudsync/core"
import type { PreviewManifest } from "@cloudsync/domain"

export interface BrowserPreviews {
  manifest: PreviewManifest
  thumbnail: Uint8Array
  preview: Uint8Array
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
async function descriptor(bytes: Uint8Array, mimeType: "image/webp" | "image/jpeg") {
  return {
    size: bytes.length,
    checksumSha256: base64(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
    ),
    mimeType,
  }
}
function canvas(width: number, height: number, bound: number) {
  const ratio = Math.min(1, bound / Math.max(width, height))
  const result = document.createElement("canvas")
  result.width = Math.max(1, Math.round(width * ratio))
  result.height = Math.max(1, Math.round(height * ratio))
  return result
}
async function rendition(source: HTMLCanvasElement, size: number, quality: number) {
  const output = canvas(source.width, source.height, size)
  const ctx = output.getContext("2d")
  if (!ctx) throw new Error("Canvas is unavailable")
  ctx.fillStyle = "#fff"
  ctx.fillRect(0, 0, output.width, output.height)
  ctx.drawImage(source, 0, 0, output.width, output.height)
  const encode = (type: string) =>
    new Promise<Blob>((resolve, reject) =>
      output.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not encode preview"))),
        type,
        quality / 100,
      ),
    )
  let blob = await encode("image/webp")
  if (blob.type !== "image/webp") blob = await encode("image/jpeg")
  output.width = output.height = 0
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType: blob.type as "image/webp" | "image/jpeg",
  }
}
async function videoFrame(file: Blob) {
  const video = document.createElement("video")
  const url = URL.createObjectURL(file)
  video.muted = true
  video.playsInline = true
  video.preload = "auto"
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Video preview timed out"))
      }, 30_000)
      const cleanup = () => {
        clearTimeout(timer)
        video.onloadeddata = null
        video.onerror = null
      }
      video.onloadeddata = () => {
        cleanup()
        resolve()
      }
      video.onerror = () => {
        cleanup()
        reject(new Error("The browser cannot decode this video"))
      }
      video.src = url
      video.load()
    })
    const output = canvas(video.videoWidth, video.videoHeight, previewSettings.preview.size)
    output.getContext("2d")?.drawImage(video, 0, 0, output.width, output.height)
    return output
  } finally {
    video.removeAttribute("src")
    video.load()
    URL.revokeObjectURL(url)
  }
}
async function pdfFrame(file: Blob) {
  const pdf = await import("pdfjs-dist")
  pdf.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default
  const task = pdf.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const original = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({
      scale: Math.min(1, previewSettings.preview.size / Math.max(original.width, original.height)),
    })
    const output = document.createElement("canvas")
    output.width = Math.ceil(viewport.width)
    output.height = Math.ceil(viewport.height)
    await page.render({ canvas: output, viewport }).promise
    return output
  } finally {
    await task.destroy()
  }
}
export async function createBrowserPreviews(file: Blob): Promise<BrowserPreviews | null> {
  const kind = previewKindForMime(file.type)
  if (kind === "none") return null
  let frame: HTMLCanvasElement
  if (kind === "pdf") frame = await pdfFrame(file)
  else if (kind === "video") frame = await videoFrame(file)
  else {
    const url = URL.createObjectURL(file)
    const img = new Image()
    try {
      img.src = url
      await img.decode()
      frame = canvas(img.naturalWidth, img.naturalHeight, previewSettings.preview.size)
      frame.getContext("2d")?.drawImage(img, 0, 0, frame.width, frame.height)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  try {
    const thumbnail = await rendition(
      frame,
      previewSettings.thumbnail.size,
      previewSettings.thumbnail.quality,
    )
    const preview = await rendition(
      frame,
      previewSettings.preview.size,
      previewSettings.preview.quality,
    )
    return {
      thumbnail: thumbnail.bytes,
      preview: preview.bytes,
      manifest: {
        version: 1,
        thumbnail: await descriptor(thumbnail.bytes, thumbnail.mimeType),
        preview: await descriptor(preview.bytes, preview.mimeType),
        isAnimated:
          file.type === "image/webp"
            ? isAnimatedWebP(new Uint8Array(await file.arrayBuffer()))
            : null,
      },
    }
  } finally {
    frame.width = frame.height = 0
  }
}
