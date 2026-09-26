import { CloudSyncError } from "@cloudsync/domain"

export function internalError(cause: unknown): CloudSyncError {
  const message = cause instanceof Error ? cause.message : "Unexpected server error"
  return new CloudSyncError({ code: "INTERNAL", message })
}

export function notFound(message = "Item not found"): CloudSyncError {
  return new CloudSyncError({ code: "NOT_FOUND", message })
}

export function invalidInput(message: string): CloudSyncError {
  return new CloudSyncError({ code: "INVALID_INPUT", message })
}
