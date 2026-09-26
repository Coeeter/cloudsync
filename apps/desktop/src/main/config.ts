import { Config, Context, Effect, Layer } from "effect"
import { app } from "electron"

export interface DesktopConfigShape {
  readonly cloudUrl: string
}

const RawConfig = Config.all({
  cloudUrl: Config.NonEmptyString("CLOUDSYNC_URL").pipe(
    Config.withDefault(app.isPackaged ? "https://sync.example.com" : "http://localhost:3000"),
  ),
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
