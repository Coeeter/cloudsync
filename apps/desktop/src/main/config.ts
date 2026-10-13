import { Config, Context, Effect, Layer } from "effect"
import { app } from "electron"

export interface DesktopConfigShape {
  readonly cloudUrl: string
}

// Packaged apps do not inherit a shell environment, so their default URL is baked in at
// build time: MAIN_VITE_CLOUDSYNC_URL=https://... bun --filter @cloudsync/desktop package
const defaultUrl: string | undefined = app.isPackaged
  ? import.meta.env.MAIN_VITE_CLOUDSYNC_URL
  : "http://localhost:3310"

const cloudUrl = Config.NonEmptyString("CLOUDSYNC_URL")

const RawConfig = Config.all({
  cloudUrl: defaultUrl ? cloudUrl.pipe(Config.withDefault(defaultUrl)) : cloudUrl,
})

export class DesktopConfig extends Context.Service<DesktopConfig, DesktopConfigShape>()(
  "@cloudsync/desktop/DesktopConfig",
) {
  static readonly layer = Layer.effect(
    DesktopConfig,
    Effect.map(RawConfig, ({ cloudUrl }) =>
      DesktopConfig.of({ cloudUrl: cloudUrl.replace(/\/$/, "") }),
    ),
  )
}
