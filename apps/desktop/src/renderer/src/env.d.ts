import type { CloudSyncDesktopApi } from "../../preload"

declare global {
  interface Window {
    readonly cloudsync: CloudSyncDesktopApi
  }
}
