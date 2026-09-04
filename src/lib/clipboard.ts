/**
 * Copies `text` from inside the click that asked for it.
 *
 * The WebView's own async clipboard is the route that needs neither a
 * selection nor focus, so it goes first; the carrier field behind it is the
 * form of copy left where that one is refused, and it has to be a real field
 * because an editing command copies a selection, not an argument.
 */
export function copyPlainText(text: string) {
  if (!text) {
    return
  }

  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => copyViaCarrier(text))

    return
  }

  copyViaCarrier(text)
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
