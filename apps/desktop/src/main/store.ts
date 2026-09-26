import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { app, safeStorage } from "electron"

export interface SavedSettings {
  readonly inbox: string | null
  readonly email: string | null
  readonly encryptedToken: string | null
}

const emptySettings: SavedSettings = { inbox: null, email: null, encryptedToken: null }
const SavedSettingsSchema = Schema.Struct({
  inbox: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  encryptedToken: Schema.NullOr(Schema.String),
})

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface DesktopStoreShape {
  readonly load: Effect.Effect<SavedSettings, StoreError>
  readonly save: (settings: SavedSettings) => Effect.Effect<void, StoreError>
  readonly encryptToken: (token: string) => Effect.Effect<string, StoreError>
  readonly decryptToken: (encrypted: string) => Effect.Effect<string, StoreError>
}

const storeError = (message: string) => (cause: unknown) => new StoreError({ message, cause })

export class DesktopStore extends Context.Service<DesktopStore, DesktopStoreShape>()(
  "@cloudsync/desktop/DesktopStore",
) {
  static readonly layer = Layer.effect(
    DesktopStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const path = pathService.join(app.getPath("userData"), "settings.json")
      const load = Effect.gen(function* () {
        const exists = yield* fileSystem
          .exists(path)
          .pipe(Effect.mapError(storeError("Could not inspect CloudSync settings")))
        if (!exists) return emptySettings
        const contents = yield* fileSystem
          .readFileString(path)
          .pipe(Effect.mapError(storeError("Could not load CloudSync settings")))
        const parsed = yield* Effect.try({
          try: () => JSON.parse(contents) as unknown,
          catch: storeError("CloudSync settings are not valid JSON"),
        })
        return yield* Schema.decodeUnknownEffect(SavedSettingsSchema)(parsed).pipe(
          Effect.mapError(storeError("CloudSync settings have an invalid shape")),
        )
      })
      const save: DesktopStoreShape["save"] = (settings) =>
        fileSystem
          .writeFileString(path, JSON.stringify(settings), { mode: 0o600 })
          .pipe(Effect.mapError(storeError("Could not save CloudSync settings")))
      const encryptToken: DesktopStoreShape["encryptToken"] = (token) =>
        Effect.try({
          try: () => {
            if (!safeStorage.isEncryptionAvailable())
              throw new Error("macOS Keychain is unavailable")
            return safeStorage.encryptString(token).toString("base64")
          },
          catch: storeError("Could not protect the session in Keychain"),
        })
      const decryptToken: DesktopStoreShape["decryptToken"] = (encrypted) =>
        Effect.try({
          try: () => {
            if (!safeStorage.isEncryptionAvailable())
              throw new Error("macOS Keychain is unavailable")
            return safeStorage.decryptString(Buffer.from(encrypted, "base64"))
          },
          catch: storeError("Could not unlock the saved session"),
        })

      return DesktopStore.of({ load, save, encryptToken, decryptToken })
    }),
  )
}
