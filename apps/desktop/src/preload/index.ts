import { contextBridge, ipcRenderer } from "electron"
import type { DesktopSnapshot } from "../main"

type Outcome = Promise<string | null>

const api = {
  state: (): Promise<DesktopSnapshot> => ipcRenderer.invoke("cloudsync:state"),
  signIn: (): Outcome => ipcRenderer.invoke("cloudsync:signIn"),
  signOut: (): Outcome => ipcRenderer.invoke("cloudsync:signOut"),
  chooseFolder: (): Outcome => ipcRenderer.invoke("cloudsync:chooseFolder"),
  retry: (): Outcome => ipcRenderer.invoke("cloudsync:retry"),
  openWebsite: (): Outcome => ipcRenderer.invoke("cloudsync:openWebsite"),
  revealInbox: (): Outcome => ipcRenderer.invoke("cloudsync:revealInbox"),
  onState: (listener: (state: DesktopSnapshot) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: DesktopSnapshot) => listener(state)
    ipcRenderer.on("cloudsync:state", handle)
    return () => ipcRenderer.off("cloudsync:state", handle)
  },
}

contextBridge.exposeInMainWorld("cloudsync", api)

export type CloudSyncDesktopApi = typeof api
