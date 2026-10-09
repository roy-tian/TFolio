import { execFileSync } from "node:child_process"
import { browser } from "@wdio/globals"

type PointerWindow = Window & { __nativePointerOffset?: { x: number; y: number } }

export function pointer(event: { x: number; y: number } | { down: boolean }) {
  execFileSync("python3", ["test/e2e/native-pointer.py", JSON.stringify(event)])
}

/** Include the native window frame rather than assuming WebView coordinates
    are screen coordinates. Move away first so recalibration always emits. */
export async function calibratePointer() {
  pointer({ x: 301, y: 301 })
  await browser.execute(() => {
    const page = window as PointerWindow
    delete page.__nativePointerOffset
    document.addEventListener("mousemove", event => {
      page.__nativePointerOffset = { x: event.screenX - event.clientX, y: event.screenY - event.clientY }
    }, { once: true })
  })
  pointer({ x: 300, y: 300 })
  await browser.waitUntil(() => browser.execute(() => Boolean((window as PointerWindow).__nativePointerOffset)))
  return browser.execute(() => (window as PointerWindow).__nativePointerOffset!)
}
