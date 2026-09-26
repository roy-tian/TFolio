import { mockIPC, mockWindows } from "@tauri-apps/api/mocks"

export function mockUpdateWindows(answers: Record<string, boolean | null>) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { crypto: globalThis.crypto },
  })
  mockWindows("main")
  const listeners = new Map<string, number>()
  const requests: string[] = []

  mockIPC((command, args) => {
    const data = args as {
      event: string
      handler: number
      target: { label: string }
      payload: { id: string; requester: string }
    }
    if (command === "plugin:window|get_all_windows") {
      return ["main", ...Object.keys(answers)]
    }
    if (command === "plugin:event|listen") {
      listeners.set(data.event, data.handler)
      return data.handler
    }
    if (command === "plugin:event|unlisten") {
      listeners.delete(data.event)
    }
    if (command === "plugin:event|emit_to") {
      requests.push(data.target.label)
      const unsaved = answers[data.target.label]
      if (unsaved === null) {
        return
      }
      const handler = listeners.get("workspace://unsaved-response")!
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { runCallback: (id: number, value: unknown) => void }
      }).__TAURI_INTERNALS__
      internals.runCallback(handler, {
        payload: { id: data.payload.id, label: data.target.label, unsaved },
      })
    }
  })

  return { listeners, requests }
}
