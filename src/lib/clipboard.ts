import { invoke } from "@tauri-apps/api/core"

import { isMacOS } from "@/lib/platform"

function fallbackCopyPlainText(text: string) {
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => copyViaCarrier(text))

    return
  }

  copyViaCarrier(text)
}

/**
 * The async clipboard goes first; where it is refused, the carrier field is a
 * real field because `execCommand` copies a selection, not an argument.
 * On macOS, a click in a native context menu happens outside WebKit's gesture,
 * so write directly to NSPasteboard when Tauri IPC is present.
 */
export function copyPlainText(text: string) {
  if (!text) {
    return
  }

  if (isMacOS() && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void invoke<boolean>("write_clipboard_text", { text })
      .then((ok) => {
        if (!ok) {
          fallbackCopyPlainText(text)
        }
      })
      .catch(() => fallbackCopyPlainText(text))

    return
  }

  fallbackCopyPlainText(text)
}

function copyViaCarrier(text: string) {
  const carrier = document.createElement("textarea")

  carrier.value = text
  carrier.readOnly = true
  carrier.style.position = "fixed"
  carrier.style.top = "0"
  carrier.style.opacity = "0"

  document.body.append(carrier)
  carrier.select()

  try {
    document.execCommand("copy")
  } finally {
    carrier.remove()
  }
}
