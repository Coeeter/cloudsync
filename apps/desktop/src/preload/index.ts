import { contextBridge, ipcRenderer } from "electron"
import type { DesktopSnapshot } from "../main"

type Outcome = Promise<string | null>

const api = {
  state: (): Promise<DesktopSnapshot> => ipcRenderer.invoke("cloudsync:state"),
  requestPin: (email: string): Outcome => ipcRenderer.invoke("cloudsync:requestPin", email),
  verifyPin: (code: string): Outcome => ipcRenderer.invoke("cloudsync:verifyPin", code),
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
