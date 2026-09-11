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

/** An editing shortcut here belongs to the field, not to the app around it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    acceptsTypedText(target.closest(editableSelector))
  )
}

/** Whether something modal stands over the workspace. While one does the
    keyboard is its own, and the window's own keys stand down. */
export function hasLayerOverWorkspace(): boolean {
  return Boolean(
    document.querySelector(
      "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']",
    ),
  )
}

/**
 * The WebView's menu is the browser's, not this app's — reload and view source
 * over a PDF. Typed-in fields keep it: there its cut/copy/paste is the only one.
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
