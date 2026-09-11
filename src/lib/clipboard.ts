/**
 * The async clipboard goes first; where it is refused, the carrier field is a
 * real field because `execCommand` copies a selection, not an argument.
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
