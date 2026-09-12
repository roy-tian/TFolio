import { isMacOS } from "@/lib/platform"

/** A chord over the platform's primary modifier — Ctrl, or Command on macOS. */
export type Shortcut = {
  alt?: boolean
  /** The letter it is written with, lower case; matched case-insensitively. */
  key: string
  shift?: boolean
}

/** What a keydown has to carry to be matched, so a test needs no live event. */
export type ShortcutEvent = {
  altKey: boolean
  code: string
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

/**
 * Named once for both halves: the keydown that runs the action and the hint
 * that promises it. None is registered with the OS.
 */
export const shortcuts = {
  new: { key: "n" },
  newWindow: { key: "n", shift: true },
  open: { key: "o" },
  pageNumbers: { alt: true, key: "p" },
  print: { key: "p" },
  save: { key: "s" },
  saveAll: { alt: true, key: "s" },
  saveAs: { key: "s", shift: true },
  search: { key: "f" },
  selectAll: { key: "a" },
  undo: { key: "z" },
  watermark: { alt: true, key: "w" },
} as const satisfies Record<string, Shortcut>

function namesLetter(event: ShortcutEvent, key: string) {
  if (event.key.toLowerCase() === key) {
    return true
  }

  // An Alt chord can compose a character instead of reporting the letter — ⌥s
  // on macOS, AltGr on some Windows layouts — leaving the physical key to name it.
  return event.altKey && event.code === `Key${key.toUpperCase()}`
}

/**
 * Every modifier is matched exactly, never merely required: ctrl+s,
 * ctrl+shift+s and ctrl+alt+s are three different chords.
 */
export function matchesShortcut(
  event: ShortcutEvent,
  shortcut: Shortcut,
  macOS = isMacOS(),
) {
  const primary = macOS ? event.metaKey : event.ctrlKey
  const foreign = macOS ? event.ctrlKey : event.metaKey

  return (
    primary &&
    !foreign &&
    event.altKey === Boolean(shortcut.alt) &&
    event.shiftKey === Boolean(shortcut.shift) &&
    namesLetter(event, shortcut.key)
  )
}

/**
 * Not a translated string: every locale writes these keys as the keyboard
 * does, in each platform's own order.
 */
export function formatShortcut(shortcut: Shortcut, macOS = isMacOS()) {
  const letter = shortcut.key.toUpperCase()

  if (macOS) {
    return `${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}⌘${letter}`
  }

  return [
    "Ctrl",
    shortcut.alt ? "Alt" : null,
    shortcut.shift ? "Shift" : null,
    letter,
  ]
    .filter((part) => part !== null)
    .join("+")
}
