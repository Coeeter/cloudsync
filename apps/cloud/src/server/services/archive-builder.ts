import { createReadStream, createWriteStream } from "node:fs"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { DatabaseError, schema } from "@cloudsync/db"
import { ZipArchive } from "archiver"
import { Effect, Schema } from "effect"
import type { StorageShape } from "./storage"

export const ARCHIVE_CONCURRENCY = 10
const STAGING_BYTES = 256 * 1024 * 1024

export class ArchiveBuildError extends Schema.TaggedError<ArchiveBuildError>()(
  "ArchiveBuildError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export function archiveBatches(entries: ReadonlyArray<schema.ArchiveManifestEntry>) {
  const batches: schema.ArchiveManifestEntry[][] = []
  let batch: schema.ArchiveManifestEntry[] = []
  let bytes = 0
  let files = 0
  for (const entry of entries) {
    if (
      batch.length &&
      entry.objectKey &&
      (files >= ARCHIVE_CONCURRENCY || bytes + entry.size > STAGING_BYTES)
    ) {
      batches.push(batch)
      batch = []
      bytes = 0
      files = 0
    }
    batch.push(entry)
    bytes += entry.size
    if (entry.objectKey) files += 1
  }
  if (batch.length) batches.push(batch)
  return batches
}

function append(archive: ZipArchive, body: Readable | string, path: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      archive.off("entry", onEntry)
      archive.off("error", onError)
      if (typeof body !== "string") body.off("error", onError)
      signal.removeEventListener("abort", onAbort)
    }
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== path) return
      cleanup()
      resolve()
    }
    const onError = (error: unknown) => {
      cleanup()
      if (typeof body !== "string") body.destroy()
      reject(error)
    }
    const onAbort = () => onError(new Error("Archive cancelled"))
    archive.on("entry", onEntry)
    archive.once("error", onError)
    if (typeof body !== "string") body.once("error", onError)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) return onAbort()
    archive.append(body, { name: path, store: true })
  })
}

export const uploadArchive = Effect.fn("Archive.upload")(function* (input: {
  objectKey: string
  entries: ReadonlyArray<schema.ArchiveManifestEntry>
  storage: StorageShape
  onProgress: (processed: number) => Effect.Effect<void, DatabaseError>
  onUploading: Effect.Effect<void, DatabaseError>
}) {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "cloudsync-archive-")),
      catch: (cause) =>
        new ArchiveBuildError({ message: "Could not create archive workspace", cause }),
    }),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  )
  const archive = new ZipArchive({ store: true })
  const output = new PassThrough()
  archive.on("error", (error) => output.destroy(error))
  // A producer failure may arrive before the multipart uploader subscribes.
  output.on("error", () => undefined)
  archive.pipe(output)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      archive.destroy()
      output.destroy()
    }),
  )

  const wrap = (message: string) => (cause: unknown) => new ArchiveBuildError({ message, cause })
  let processed = 0
  const feeding = Effect.gen(function* () {
    for (const batch of archiveBatches(input.entries)) {
      const files = yield* Effect.forEach(
        batch,
        (entry, index) =>
          Effect.gen(function* () {
            if (!entry.objectKey) return { entry, file: null }
            const object = yield* input.storage.get(entry.objectKey)
            const file = join(directory, String(index))
            yield* Effect.tryPromise({
              try: async (signal) => {
                await pipeline(object.body, createWriteStream(file), { signal })
                if ((await stat(file)).size !== entry.size)
                  throw new Error("Source file size changed")
              },
              catch: wrap(`Could not download “${entry.path}”`),
            })
            processed += 1
            yield* input.onProgress(processed)
            return { entry, file }
          }),
        { concurrency: ARCHIVE_CONCURRENCY },
      )

      for (const { entry, file } of files) {
        yield* Effect.tryPromise({
          try: (signal) => append(archive, file ? createReadStream(file) : "", entry.path, signal),
          catch: wrap(`Could not archive “${entry.path}”`),
        })
        if (file)
          yield* Effect.tryPromise({
            try: () => rm(file),
            catch: wrap("Could not clean archive workspace"),
          })
      }
    }
    yield* input.onUploading
    yield* Effect.tryPromise({
      try: () => archive.finalize(),
      catch: wrap("Could not finalize ZIP"),
    })
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        archive.destroy(error instanceof Error ? error : new Error("Archive failed")),
      ),
    ),
  )

  yield* Effect.all(
    [feeding, input.storage.putStream(input.objectKey, output, "application/zip")],
    { concurrency: 2 },
  )
}, Effect.scoped)
