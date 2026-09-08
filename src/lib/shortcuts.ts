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
 * Every chord the window answers, named once for both halves: the keydown that
 * runs the action and the hint that promises it. These belong to this window
 * while it holds the keyboard — none is registered with the OS, so nothing here
 * is taken from the desktop around it.
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
  // on macOS, AltGr (which Windows reports as ctrl+alt) on the layouts that map
  // it — and then the physical key is all that still names it.
  return event.altKey && event.code === `Key${key.toUpperCase()}`
}

/**
 * Every modifier is matched exactly, never merely required: ctrl+s, ctrl+shift+s
 * and ctrl+alt+s are three different chords, and each must leave the other two
 * to their own actions.
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
 * How the chord is written on screen. Not a translated string: every locale
 * writes these keys the way the keyboard does, in each platform's own order —
 * Apple's ⌥⇧⌘ before the letter, Ctrl+Alt+Shift+Letter everywhere else.
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
