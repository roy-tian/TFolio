/** The `input` types a reader types into. The rest — a checkbox, a colour
    swatch, a file button — hold nothing to cut, copy or paste. */
const textInputTypes = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
])

/** What a right-click has to land in, given to `Element.closest`. */
const editableSelector = "input, textarea, [contenteditable]"

type EditableField = {
  disabled?: boolean
  isContentEditable?: boolean
  readOnly?: boolean
  tagName: string
  type?: string
}

export function acceptsTypedText(field: EditableField | null): boolean {
  if (!field) {
    return false
  }

  const tag = field.tagName.toLowerCase()

  if (tag !== "input" && tag !== "textarea") {
    return field.isContentEditable === true
  }

  if (field.disabled || field.readOnly) {
    return false
  }

  // An `input` carrying no `type` reports "text".
  return tag === "textarea" || textInputTypes.has(field.type ?? "text")
}

/** Whether an event landed in a field the reader types into, where an editing
    shortcut belongs to the field rather than to the app around it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    acceptsTypedText(target.closest(editableSelector))
  )
}

/**
 * Drops the WebView's own context menu, which is the browser's and not this
 * app's: it offers a reader reload, back and view source over a page of a PDF.
 * The one thing on that page worth a right-click — copying selected text — the
 * app puts in a menu of its own (`PageTextMenu`). A field being typed in keeps
 * the native menu, since there its cut/copy/paste is the only one there is.
 *
 * Right-click devtools go with it; a debug build still opens the inspector
 * from the keyboard.
 */
export function suppressNativeContextMenu() {
  window.addEventListener("contextmenu", (event) => {
    const target = event.target

    if (
      target instanceof Element &&
      acceptsTypedText(target.closest(editableSelector))
    ) {
      return
    }

    event.preventDefault()
  })
}
