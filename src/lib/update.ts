import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

/**
 * The release check, as the interface sees it.
 *
 * Every part of it lives in `src-tauri/src/update.rs`: the request to GitHub,
 * the signature check over what comes back, and the install. Nothing here names
 * a URL or a file, because nothing here may — the endpoint and the key are
 * compiled into the bundle. This module only reads a status the backend keeps
 * for the whole process, so two windows never disagree about it and never
 * download the same release twice.
 *
 * Silence is a state: an app already on the newest release and an app that
 * could not reach GitHub at all both stay `idle`, and nothing is shown for
 * either. Only a step the reader pressed for reports that it went wrong.
 */
export type AppUpdateStatus =
  | { state: "idle" }
  | { state: "available"; version: string }
  | {
      state: "downloading"
      version: string
      received: number
      /** Null until the response says how much there is to receive. */
      total: number | null
    }
  | { state: "ready"; version: string }
  | { state: "failed"; version: string }

/** Named in `src-tauri/src/update.rs` too; the two have to be changed together. */
const UPDATE_CHANGED_EVENT = "update://changed"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** The status crosses IPC, so it earns its type on the way in: a payload this
    version cannot place leaves the window on the one it is already showing. */
export function isAppUpdateStatus(value: unknown): value is AppUpdateStatus {
  if (!isRecord(value)) {
    return false
  }

  switch (value.state) {
    case "idle":
      return true
    case "available":
    case "ready":
    case "failed":
      return typeof value.version === "string"
    case "downloading":
      return (
        typeof value.version === "string" &&
        typeof value.received === "number" &&
        (value.total === null || typeof value.total === "number")
      )
    default:
      return false
  }
}

/**
 * Whether the notice belongs on screen. An app with nothing to update says
 * nothing at all, and a notice the reader waved away stays away — until the
 * update reaches a state they have not answered yet, which is news again.
 */
export function shouldShowUpdate(
  status: AppUpdateStatus,
  dismissedState: AppUpdateStatus["state"] | null,
): boolean {
  return status.state !== "idle" && status.state !== dismissedState
}

/** What this window has missed: the check runs before there is a page to hear
    it, so every window asks once and follows the event from then on. */
export async function readUpdateStatus(): Promise<AppUpdateStatus> {
  const status: unknown = await invoke("update_status")

  return isAppUpdateStatus(status) ? status : { state: "idle" }
}

export function watchUpdateStatus(
  onChange: (status: AppUpdateStatus) => void,
) {
  return listen<unknown>(UPDATE_CHANGED_EVENT, (event) => {
    if (isAppUpdateStatus(event.payload)) {
      onChange(event.payload)
    }
  })
}

export function downloadUpdate(): Promise<void> {
  return invoke("download_update")
}

export function installUpdate(): Promise<void> {
  return invoke("install_update")
}
