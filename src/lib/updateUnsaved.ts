import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event"
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window"

const REQUEST_EVENT = "update://unsaved-request"
const RESPONSE_EVENT = "update://unsaved-response"

type Request = { id: string; requester: string }
type Response = { id: string; label: string; unsaved: boolean }

export function watchUpdateUnsaved(hasUnsavedWorkNow: () => boolean) {
  const label = getCurrentWindow().label

  return listen<Request>(REQUEST_EVENT, ({ payload }) => {
    void emitTo(payload.requester, RESPONSE_EVENT, {
      id: payload.id,
      label,
      unsaved: hasUnsavedWorkNow(),
    } satisfies Response).catch(() => undefined)
  }, { target: label })
}

export async function updateNeedsConfirmation(
  hasUnsavedWorkNow: () => boolean,
): Promise<boolean> {
  if (hasUnsavedWorkNow()) {
    return true
  }

  let unlisten: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const requester = getCurrentWindow().label
    const pending = new Set(
      (await getAllWindows())
        .map((window) => window.label)
        .filter((label) => label !== requester),
    )

    if (pending.size === 0) {
      return hasUnsavedWorkNow()
    }

    const id = crypto.randomUUID()
    let finish: (unsaved: boolean) => void = () => undefined
    const answer = new Promise<boolean>((resolve) => {
      finish = resolve
    })

    unlisten = await listen<Response>(RESPONSE_EVENT, ({ payload }) => {
      if (payload.id !== id || !pending.delete(payload.label)) {
        return
      }

      if (payload.unsaved !== false) {
        finish(true)
      } else if (pending.size === 0) {
        finish(false)
      }
    }, { target: requester })

    // An unresponsive or reloading window cannot vouch for its work, so keep
    // the discard confirmation when its answer is missing.
    timer = setTimeout(() => finish(true), 1_500)
    for (const label of pending) {
      void emitTo(label, REQUEST_EVENT, { id, requester } satisfies Request)
        .catch(() => finish(true))
    }

    return (await answer) || hasUnsavedWorkNow()
  } catch {
    return true
  } finally {
    clearTimeout(timer)
    unlisten?.()
  }
}
