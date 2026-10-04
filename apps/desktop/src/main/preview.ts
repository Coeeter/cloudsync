import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { isAnimatedWebP, previewKindForMime, previewSettings } from "@cloudsync/core"
import type { PreviewManifest } from "@cloudsync/domain"

const execute = promisify(execFile)

// Finder-launched apps do not inherit the shell's Homebrew PATH.
function executable(name: string) {
  return (
    ["/opt/homebrew/bin", "/usr/local/bin"]
      .map((directory) => join(directory, name))
      .find(existsSync) ?? name
  )
}

export interface LocalPreviews {
  readonly manifest: PreviewManifest
  readonly thumbnail: Uint8Array
  readonly preview: Uint8Array
}

export async function createLocalPreviews(
  original: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
): Promise<LocalPreviews | null> {
  const kind = previewKindForMime(mimeType)
  if (kind === "none") return null
  const directory = await mkdtemp(join(tmpdir(), "cloudsync-preview-"))
  try {
    const input = join(directory, "input")
    const frame = join(directory, "frame.png")
    await writeFile(input, original)
    const options = { signal, timeout: 60_000, maxBuffer: 1024 * 1024 }
    if (kind === "pdf") {
      await execute(
        executable("pdftoppm"),
        [
          "-f",
          "1",
          "-singlefile",
          "-png",
          "-scale-to",
          String(previewSettings.preview.size),
          input,
          join(directory, "frame"),
        ],
        options,
      )
    } else {
      const bound = previewSettings.preview.size
      await execute(
        executable("ffmpeg"),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-threads",
          "1",
          "-i",
          input,
          "-filter_threads",
          "1",
          "-vf",
          `${kind === "video" ? "thumbnail," : ""}scale=w='min(${bound},iw)':h='min(${bound},ih)':force_original_aspect_ratio=decrease`,
          "-frames:v",
          "1",
          "-y",
          frame,
        ],
        options,
      )
    }
    const png = await readFile(frame)
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    const ratio = Math.min(1, previewSettings.thumbnail.size / Math.max(width, height))
    const thumbnailPath = join(directory, "thumbnail.webp")
    const previewPath = join(directory, "preview.webp")
    await Promise.all([
      execute(
        executable("cwebp"),
        [
          "-quiet",
          "-q",
          String(previewSettings.thumbnail.quality),
          "-resize",
          String(Math.max(1, Math.round(width * ratio))),
          String(Math.max(1, Math.round(height * ratio))),
          frame,
          "-o",
          thumbnailPath,
        ],
        options,
      ),
      execute(
        executable("cwebp"),
        ["-quiet", "-q", String(previewSettings.preview.quality), frame, "-o", previewPath],
        options,
      ),
    ])
    const [thumbnail, preview] = await Promise.all([readFile(thumbnailPath), readFile(previewPath)])
    const descriptor = (bytes: Uint8Array) => ({
      size: bytes.length,
      checksumSha256: createHash("sha256").update(bytes).digest("base64"),
    })
    return {
      thumbnail,
      preview,
      manifest: {
        version: previewSettings.version,
        thumbnail: descriptor(thumbnail),
        preview: descriptor(preview),
        isAnimated: mimeType === "image/webp" ? isAnimatedWebP(original) : null,
      },
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
