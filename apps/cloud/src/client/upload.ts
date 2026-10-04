import { completeDirectUpload, type PreparedUpload } from "@cloudsync/core"
import type { Entry, UploadTicket } from "@cloudsync/domain"
import { Effect, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { CloudSync } from "./rpc"

export class BrowserUploadError extends Schema.TaggedError<BrowserUploadError>()(
  "BrowserUploadError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

interface DroppedFileEntry {
  readonly isFile: true
  readonly isDirectory: false
  readonly name: string
  readonly file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void
}

interface DroppedDirectoryReader {
  readonly readEntries: (
    success: (entries: ReadonlyArray<DroppedEntry>) => void,
    failure?: (error: DOMException) => void,
  ) => void
}

interface DroppedDirectoryEntry {
  readonly isFile: false
  readonly isDirectory: true
  readonly name: string
  readonly createReader: () => DroppedDirectoryReader
}

type DroppedEntry = DroppedFileEntry | DroppedDirectoryEntry

export interface DroppedFile {
  readonly file: File
  readonly relativePath: string
}

const readDroppedFile = (entry: DroppedFileEntry) =>
  Effect.tryPromise({
    try: () =>
      new Promise<File>((resolve, reject) => {
        entry.file(resolve, reject)
      }),
    catch: (cause) => new BrowserUploadError({ message: `Could not read ${entry.name}`, cause }),
  })

const readDirectoryBatch = (reader: DroppedDirectoryReader) =>
  Effect.tryPromise({
    try: () =>
      new Promise<ReadonlyArray<DroppedEntry>>((resolve, reject) => {
        reader.readEntries(resolve, reject)
      }),
    catch: (cause) =>
      new BrowserUploadError({ message: "Could not read the dropped folder", cause }),
  })

const walkDroppedEntry = Effect.fn("walkDroppedEntry")(function* (
  entry: DroppedEntry,
  prefix: string,
): Effect.fn.Return<ReadonlyArray<DroppedFile>, BrowserUploadError> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = yield* readDroppedFile(entry)
    if (file.name === ".DS_Store") return []
    return [{ file, relativePath }]
  }

  const reader = entry.createReader()
  const children: Array<DroppedEntry> = []
  while (true) {
    const batch = yield* readDirectoryBatch(reader)
    if (batch.length === 0) break
    children.push(...batch)
  }
  return yield* Effect.map(
    Effect.forEach(children, (child) => walkDroppedEntry(child, relativePath), { concurrency: 8 }),
    (nested) => nested.flat(),
  )
})

export const collectDroppedFiles = Effect.fn("collectDroppedFiles")(function* (
  items: DataTransferItemList,
) {
  const entries = Array.from(items)
    .map((item) => item.webkitGetAsEntry?.() as DroppedEntry | null)
    .filter((entry): entry is DroppedEntry => entry !== null)
  return yield* Effect.map(
    Effect.forEach(entries, (entry) => walkDroppedEntry(entry, ""), { concurrency: 8 }),
    (nested) => nested.flat(),
  )
})

const reason = (fallback: string) => (cause: unknown) =>
  new BrowserUploadError({
    message:
      typeof cause === "object" && cause !== null && "code" in cause && "message" in cause
        ? String(cause.message)
        : fallback,
    cause,
  })

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 1)
    binary += String.fromCharCode(bytes[index] ?? 0)
  return btoa(binary)
}

export const uploadBrowserFile = Effect.fn("uploadBrowserFile")(function* (
  file: File,
  parentId: string | null,
  relativePath = file.name,
) {
  const bytes = new Uint8Array(
    yield* Effect.tryPromise({
      try: () => file.arrayBuffer(),
      catch: (cause) => new BrowserUploadError({ message: "Could not read the file", cause }),
    }),
  )
  const digest = new Uint8Array(
    yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", bytes),
      catch: (cause) => new BrowserUploadError({ message: "Could not checksum the file", cause }),
    }),
  )

  const client = yield* CloudSync
  const begin = (upload: PreparedUpload) =>
    client("upload.begin", upload).pipe(Effect.mapError(reason("Could not start the upload")))
  const finalize = (uploadId: string): Effect.Effect<Entry, BrowserUploadError> =>
    client("upload.finalize", { uploadId }).pipe(
      Effect.mapError(reason("Could not verify the upload")),
    )
  const put = (ticket: UploadTicket) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const request = HttpClientRequest.put(ticket.url).pipe(
        HttpClientRequest.bodyUint8Array(bytes),
        HttpClientRequest.setHeaders(ticket.headers),
      )
      const response = yield* client.execute(request)
      yield* HttpClientResponse.filterStatusOk(response)
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new BrowserUploadError({
            message: cause.response
              ? `Storage rejected the upload (HTTP ${cause.response.status})`
              : "Could not reach storage",
            cause,
          }),
      ),
    )

  return yield* completeDirectUpload(
    {
      parentId,
      relativePath,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      checksumSha256: base64(digest),
      modifiedAt: new Date(file.lastModified).toISOString(),
    },
    { begin, put, finalize },
  )
})
