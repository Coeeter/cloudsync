import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron"
import { DesktopConfig } from "./config"
import { Inbox, type InboxSnapshot } from "./inbox"
import { missingPreviewTools } from "./preview"
import { Remote } from "./remote"
import { DesktopStore, type SavedSettings } from "./store"

const RemoteLive = Remote.layer.pipe(Layer.provideMerge(DesktopConfig.layer))
const InboxLive = Inbox.layer.pipe(Layer.provideMerge(RemoteLive))
const AppLive = Layer.mergeAll(DesktopStore.layer, InboxLive).pipe(
  Layer.provideMerge(NodeServices.layer),
)
const runtime = ManagedRuntime.make(AppLive)

export interface DesktopSnapshot extends InboxSnapshot {
  readonly missingTools: readonly string[]
  readonly authenticated: boolean
  readonly email: string | null
  readonly cloudUrl: string
  readonly error: string | null
}

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let settings: SavedSettings = { inbox: null, email: null, encryptedToken: null }
let token: string | null = null
let error: string | null = null
let cloudUrl = ""
let missingTools: string[] = []

const message = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const text = String(cause.message)
    if (text) return text
  }
  return "CloudSync could not complete that operation"
}

const snapshot = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const status = yield* inbox.snapshot
      return {
        ...status,
        missingTools,
        authenticated: token !== null,
        email: settings.email,
        cloudUrl,
        error,
      } satisfies DesktopSnapshot
    }),
  )

const publish = async () => {
  const state = await snapshot()
  window?.webContents.send("cloudsync:state", state)
  updateTray(state)
}

const persist = (next: SavedSettings) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* DesktopStore
      yield* store.save(next)
      settings = next
    }),
  )

const startInbox = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      if (missingTools.length || !settings.inbox || !token) return
      const inbox = yield* Inbox
      yield* inbox.start(settings.inbox, token)
    }),
  )

// IPC rejections surface in the renderer as opaque "Error invoking remote method" strings,
// so failures are reported through the published snapshot instead.
const handle = (channel: string, operation: (argument: string) => Promise<void>) =>
  ipcMain.handle(channel, async (_event, argument: unknown) => {
    try {
      if (missingTools.length) throw new Error("Install the required tools and restart CloudSync")
      await operation(typeof argument === "string" ? argument : "")
      error = null
    } catch (cause) {
      error = message(cause)
    }
    await publish()
    return error
  })

function updateTray(state: DesktopSnapshot) {
  if (!tray) return
  const status = !state.authenticated
    ? "Signed out"
    : !state.watching
      ? "No inbox selected"
      : state.active.length > 0
        ? `Archiving ${state.active.length} · ${state.pending} waiting`
        : state.failed.length > 0
          ? `${state.failed.length} need attention`
          : "Inbox is caught up"
  tray.setToolTip(`CloudSync — ${status}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: "separator" },
      { label: "Open CloudSync", click: () => void showWindow() },
      { label: "Open website", click: () => void shell.openExternal(cloudUrl) },
      {
        label: "Retry failed files",
        enabled: state.failed.length > 0,
        click: () => void runtime.runPromise(Effect.flatMap(Inbox, (inbox) => inbox.retry)),
      },
      { type: "separator" },
      { label: "Quit CloudSync", click: () => app.quit() },
    ]),
  )
}

async function showWindow() {
  if (window) {
    window.show()
    window.focus()
    return
  }
  window = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 460,
    minHeight: 560,
    show: false,
    backgroundColor: "#0b0c0e",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      // ESM preload scripts only load outside the renderer sandbox.
      sandbox: false,
      contextIsolation: true,
    },
  })
  window.once("ready-to-show", () => window?.show())
  window.on("close", (event) => {
    if (quitting) return
    event.preventDefault()
    window?.hide()
  })
  window.on("closed", () => {
    window = null
  })
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(import.meta.dirname, "../renderer/index.html"))
}

function registerIpc() {
  ipcMain.handle("cloudsync:state", () => snapshot())
  handle("cloudsync:requestPin", async (email: string) => {
    const trimmed = email.trim()
    await runtime.runPromise(Effect.flatMap(Remote, (remote) => remote.requestPin(trimmed)))
    await persist({ ...settings, email: trimmed })
  })
  handle("cloudsync:verifyPin", async (code: string) => {
    if (!settings.email) throw new Error("Enter your email first")
    const email = settings.email
    const next = await runtime.runPromise(
      Effect.flatMap(Remote, (remote) => remote.verifyPin(email, code)),
    )
    const encryptedToken = await runtime.runPromise(
      Effect.flatMap(DesktopStore, (store) => store.encryptToken(next)),
    )
    await persist({ ...settings, encryptedToken })
    token = next
    await startInbox()
  })
  handle("cloudsync:signOut", async () => {
    await runtime.runPromise(Effect.flatMap(Inbox, (inbox) => inbox.stop))
    token = null
    await persist({ ...settings, encryptedToken: null })
  })
  handle("cloudsync:chooseFolder", async () => {
    const options = {
      title: "Choose the CloudSync inbox",
      message: "Everything placed in this folder is uploaded to CloudSync and then removed.",
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const inbox = result.filePaths[0]
    if (result.canceled || !inbox) return
    await persist({ ...settings, inbox })
    await startInbox()
  })
  handle("cloudsync:retry", () => runtime.runPromise(Effect.flatMap(Inbox, (inbox) => inbox.retry)))
  handle("cloudsync:openWebsite", () => shell.openExternal(cloudUrl))
  handle("cloudsync:revealInbox", async () => {
    if (settings.inbox) await shell.openPath(settings.inbox)
  })
}

async function bootstrap() {
  missingTools = await missingPreviewTools()
  await runtime.context()
  cloudUrl = await runtime.runPromise(Effect.map(DesktopConfig, (config) => config.cloudUrl))
  settings = await runtime.runPromise(Effect.flatMap(DesktopStore, (store) => store.load))
  const encrypted = settings.encryptedToken
  const saved = encrypted
    ? await runtime
        .runPromise(Effect.flatMap(DesktopStore, (store) => store.decryptToken(encrypted)))
        .catch(() => null)
    : null
  if (saved && !missingTools.length) {
    const verdict = await runtime.runPromise(
      Effect.flatMap(Remote, (remote) => remote.authenticate(saved)).pipe(
        Effect.as("valid" as const),
        Effect.catch((cause) =>
          Effect.succeed(cause.unauthorized ? ("rejected" as const) : ("offline" as const)),
        ),
      ),
    )
    // Only an explicit rejection discards the session; an offline start keeps it.
    if (verdict !== "rejected") token = saved
    if (verdict === "offline") error = `Could not reach ${cloudUrl}. Uploads will retry.`
  }
  if (encrypted && !token && !missingTools.length)
    await persist({ ...settings, encryptedToken: null })
  registerIpc()
  await runtime.runPromise(Effect.map(Inbox, (inbox) => inbox.subscribe(() => void publish())))

  const resources = app.isPackaged
    ? process.resourcesPath
    : join(import.meta.dirname, "../../resources")
  const trayIcon = nativeImage.createFromPath(join(resources, "trayTemplate.png"))
  trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  if (!app.isPackaged) app.dock?.setIcon(join(import.meta.dirname, "../../build/icon.png"))
  tray.on("click", () => tray?.popUpContextMenu())

  await showWindow()
  if (token && settings.inbox) await startInbox()
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true })
  await publish()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => void showWindow())
  app.on("activate", () => void showWindow())
  app
    .whenReady()
    .then(bootstrap)
    .catch((cause) => {
      dialog.showErrorBox("CloudSync could not start", message(cause))
      app.quit()
    })
}

// The window only hides on close; the inbox watcher keeps running from the menu bar.
app.on("window-all-closed", () => {})
app.on("before-quit", () => {
  quitting = true
  void runtime.dispose()
})
