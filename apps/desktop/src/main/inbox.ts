import { createHash } from "node:crypto"
import { completeDirectUpload } from "@cloudsync/core"
import chokidar, { type FSWatcher } from "chokidar"
import {
  ByteSize,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { Notification } from "electron"
import { Remote } from "./remote"
import { SizeQueue } from "./size-queue"

export interface InboxSnapshot {
  readonly watching: string | null
  readonly pending: number
  readonly active: ReadonlyArray<string>
  readonly failed: ReadonlyArray<{ readonly path: string; readonly message: string }>
  readonly uploaded: number
}

export class InboxError extends Schema.TaggedError<InboxError>()("InboxError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface InboxShape {
  readonly start: (folder: string, token: string) => Effect.Effect<void, InboxError>
  readonly stop: Effect.Effect<void>
  readonly retry: Effect.Effect<void>
  readonly snapshot: Effect.Effect<InboxSnapshot>
  readonly subscribe: (listener: (snapshot: InboxSnapshot) => void) => () => void
}

const inboxError = (message: string) => (cause: unknown) =>
  new InboxError({
    message:
      typeof cause === "object" && cause !== null && "message" in cause && cause.message
        ? `${message}: ${String(cause.message)}`
        : message,
    cause,
  })

function mimeFor(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase()
  return (
    (
      {
        avif: "image/avif",
        gif: "image/gif",
        heic: "image/heic",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        mkv: "video/x-matroska",
        mov: "video/quicktime",
        mp4: "video/mp4",
        pdf: "application/pdf",
        png: "image/png",
        webm: "video/webm",
        webp: "image/webp",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  )
}

const CONCURRENCY = 6

export class Inbox extends Context.Service<Inbox, InboxShape>()("@cloudsync/desktop/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const remote = yield* Remote
      const fileSystem = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const serviceContext = yield* Effect.context<Remote>()
      let watcher: FSWatcher | null = null
      let root: string | null = null
      let token: string | null = null
      let uploaded = 0
      const active = new Set<string>()
      const queue = new SizeQueue()
      const failed = new Map<string, { readonly message: string; readonly size: number }>()
      let pendingNotices = 0
      let noticeTimer: ReturnType<typeof setTimeout> | null = null
      const listeners = new Set<(snapshot: InboxSnapshot) => void>()

      const current = (): InboxSnapshot => ({
        watching: root,
        pending: queue.size,
        active: Array.from(active),
        failed: Array.from(failed, ([path, { message }]) => ({ path, message })),
        uploaded,
      })
      const publish = () => {
        const value = current()
        for (const listener of listeners) listener(value)
      }

      const removeEmptyParents = Effect.fn("Inbox.removeEmptyParents")(
        function* (file: string) {
          if (!root) return
          let directory = pathService.dirname(file)
          while (directory !== root && directory.startsWith(`${root}${pathService.sep}`)) {
            const children = yield* fileSystem.readDirectory(directory)
            if (children.length > 0) return
            yield* fileSystem.remove(directory)
            directory = pathService.dirname(directory)
          }
        },
        (effect) => Effect.ignore(effect),
      )

      const hashFile = Effect.fn("Inbox.hashFile")(function* (path: string) {
        const hash = createHash("sha256")
        yield* fileSystem.stream(path).pipe(
          Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
          Effect.mapError(inboxError(`Could not checksum ${path}`)),
        )
        return hash.digest("base64")
      })

      const fileVersion = Effect.fn("Inbox.fileVersion")(function* (path: string) {
        const info = yield* fileSystem
          .stat(path)
          .pipe(Effect.mapError(inboxError(`Could not inspect ${path}`)))
        return {
          isFile: info.type === "File",
          size: Number(ByteSize.toBigInt(info.size)),
          modifiedAt: Option.getOrElse(info.mtime, () => new Date(0)),
        }
      })

      const uploadOne = (path: string) =>
        Effect.gen(function* () {
          if (!root || !token) return
          const localRoot = root
          const sessionToken = token
          const before = yield* fileVersion(path)
          if (!before.isFile) return
          const isLink = yield* fileSystem.readLink(path).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          if (isLink) return
          const relativePath = pathService
            .relative(localRoot, path)
            .split(pathService.sep)
            .join("/")
          if (
            !relativePath ||
            relativePath.startsWith("../") ||
            relativePath.split("/").includes(".DS_Store")
          )
            return
          const checksumSha256 = yield* hashFile(path)
          const stable = yield* fileVersion(path)
          if (
            before.size !== stable.size ||
            before.modifiedAt.getTime() !== stable.modifiedAt.getTime()
          ) {
            queue.set(path, stable.size)
            return
          }
          const bytes = yield* fileSystem
            .readFile(path)
            .pipe(Effect.mapError(inboxError(`Could not read ${relativePath}`)))
          yield* completeDirectUpload(
            {
              parentId: null,
              relativePath,
              size: stable.size,
              mimeType: mimeFor(path),
              checksumSha256,
              modifiedAt: stable.modifiedAt.toISOString(),
            },
            {
              begin: (upload) => remote.begin(sessionToken, upload),
              put: (ticket) => remote.put(ticket, bytes),
              finalize: (uploadId) => remote.finalize(sessionToken, uploadId),
            },
          ).pipe(
            Effect.retry({
              times: 3,
              schedule: Schedule.exponential("2 seconds"),
              while: (error) => !error.unauthorized,
            }),
            Effect.mapError(inboxError(`Could not archive ${relativePath}`)),
          )

          const after = yield* fileVersion(path)
          if (
            after.size !== stable.size ||
            after.modifiedAt.getTime() !== stable.modifiedAt.getTime()
          ) {
            queue.set(path, after.size)
            return
          }
          yield* fileSystem
            .remove(path)
            .pipe(
              Effect.mapError(
                inboxError(`Archived ${relativePath}, but could not remove the local copy`),
              ),
            )
          yield* removeEmptyParents(path)
          failed.delete(path)
          uploaded += 1
        })

      // Batches failure notifications so an outage does not raise one per file.
      const notifyFailure = () => {
        pendingNotices += 1
        if (noticeTimer) return
        noticeTimer = setTimeout(() => {
          const count = pendingNotices
          pendingNotices = 0
          noticeTimer = null
          if (!Notification.isSupported()) return
          new Notification({
            title: "CloudSync needs attention",
            body:
              count === 1
                ? "A file could not be archived. It is still in your inbox."
                : `${count} files could not be archived. They are still in your inbox.`,
          }).show()
        }, 5000)
      }

      const runOne = async (path: string, size: number) => {
        try {
          await Effect.runPromiseWith(serviceContext)(uploadOne(path))
        } catch (cause) {
          const message =
            typeof cause === "object" && cause !== null && "message" in cause
              ? String(cause.message)
              : "Upload failed"
          failed.set(path, { message, size })
          notifyFailure()
        }
      }

      const pump = () => {
        while (active.size < CONCURRENCY) {
          const next = queue.take(active)
          if (!next) break
          const { path, size } = next
          active.add(path)
          void runOne(path, size).finally(() => {
            active.delete(path)
            publish()
            pump()
          })
        }
        publish()
      }

      const enqueue = (path: string, size: number) => {
        queue.set(path, size)
        failed.delete(path)
        pump()
      }

      const stop = Effect.promise(async () => {
        await watcher?.close()
        watcher = null
        root = null
        token = null
        queue.clear()
        publish()
      })

      const start: InboxShape["start"] = (folder, sessionToken) =>
        Effect.gen(function* () {
          yield* stop
          root = pathService.resolve(folder)
          token = sessionToken
          watcher = chokidar.watch(root, {
            ignoreInitial: false,
            persistent: true,
            awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
            followSymlinks: false,
            alwaysStat: true,
            ignored: (path) => path.split(pathService.sep).includes(".DS_Store"),
          })
          watcher.on("add", (path, stats) => enqueue(path, stats?.size ?? 0))
          watcher.on("change", (path, stats) => enqueue(path, stats?.size ?? 0))
          watcher.on("error", (cause) => {
            failed.set(root ?? folder, {
              message: cause instanceof Error ? cause.message : "Watcher failed",
              size: 0,
            })
            publish()
          })
          publish()
        }).pipe(Effect.mapError(inboxError(`Could not watch ${folder}`)))

      const retry = Effect.sync(() => {
        const retrying = Array.from(failed)
        failed.clear()
        for (const [path, { size }] of retrying) enqueue(path, size)
        publish()
      })

      return Inbox.of({
        start,
        stop,
        retry,
        snapshot: Effect.sync(current),
        subscribe: (listener) => {
          listeners.add(listener)
          listener(current())
          return () => listeners.delete(listener)
        },
      })
    }),
  )
}
