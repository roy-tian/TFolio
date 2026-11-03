import { describe, expect, test } from "bun:test"

import {
  formatShortcut,
  matchesShortcut,
  shortcuts,
  zoomShortcut,
  type ShortcutEvent,
} from "./shortcuts"

function keyDown(overrides: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return {
    altKey: false,
    code: "",
    ctrlKey: false,
    key: "",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  }
}

describe("matchesShortcut", () => {
  test("answers the platform's own primary modifier", () => {
    expect(
      matchesShortcut(keyDown({ ctrlKey: true, key: "s" }), shortcuts.save, false),
    ).toBe(true)
    expect(
      matchesShortcut(keyDown({ metaKey: true, key: "s" }), shortcuts.save, true),
    ).toBe(true)
  })

  test("leaves the other platform's modifier alone", () => {
    expect(
      matchesShortcut(keyDown({ metaKey: true, key: "s" }), shortcuts.save, false),
    ).toBe(false)
    expect(
      matchesShortcut(keyDown({ ctrlKey: true, key: "s" }), shortcuts.save, true),
    ).toBe(false)
  })

  test("keeps the three save chords apart", () => {
    const plain = keyDown({ ctrlKey: true, key: "s" })
    const shifted = keyDown({ ctrlKey: true, key: "s", shiftKey: true })
    const alted = keyDown({ altKey: true, ctrlKey: true, key: "s" })

    expect(matchesShortcut(plain, shortcuts.save, false)).toBe(true)
    expect(matchesShortcut(plain, shortcuts.saveAs, false)).toBe(false)
    expect(matchesShortcut(plain, shortcuts.saveAll, false)).toBe(false)

    expect(matchesShortcut(shifted, shortcuts.saveAs, false)).toBe(true)
    expect(matchesShortcut(shifted, shortcuts.save, false)).toBe(false)

    expect(matchesShortcut(alted, shortcuts.saveAll, false)).toBe(true)
    expect(matchesShortcut(alted, shortcuts.save, false)).toBe(false)
  })

  test("keeps printing apart from page numbers", () => {
    const alted = keyDown({ altKey: true, ctrlKey: true, key: "p" })

    expect(matchesShortcut(alted, shortcuts.print, false)).toBe(false)
    expect(matchesShortcut(alted, shortcuts.pageNumbers, false)).toBe(true)
  })

  test("reads an Alt chord off the physical key", () => {
    // ⌥⌘w on a US layout: the character the Option chord composed, not "w".
    const optioned = keyDown({
      altKey: true,
      code: "KeyW",
      key: "∑",
      metaKey: true,
    })

    expect(matchesShortcut(optioned, shortcuts.watermark, true)).toBe(true)

    // The same on Windows, where AltGr arrives as ctrl+alt and a layout that
    // maps the key composes from it — ctrl+alt+w would be unreachable there.
    const altGr = keyDown({
      altKey: true,
      code: "KeyW",
      ctrlKey: true,
      key: "ł",
    })

    expect(matchesShortcut(altGr, shortcuts.watermark, false)).toBe(true)

    // No Alt, no composition to see through, so no key is read off position:
    // ctrl+; on Dvorak sits where a QWERTY "s" would and must not save.
    expect(
      matchesShortcut(
        keyDown({ code: "KeyS", ctrlKey: true, key: ";" }),
        shortcuts.save,
        false,
      ),
    ).toBe(false)
  })

  test("ignores the letter's case and the bare key", () => {
    expect(
      matchesShortcut(keyDown({ ctrlKey: true, key: "Z" }), shortcuts.undo, false),
    ).toBe(true)
    expect(matchesShortcut(keyDown({ key: "z" }), shortcuts.undo, false)).toBe(
      false,
    )
  })

  test("tells redo apart from undo by Shift alone", () => {
    const redo = keyDown({ ctrlKey: true, key: "Z", shiftKey: true })

    expect(matchesShortcut(redo, shortcuts.redo, false)).toBe(true)
    expect(matchesShortcut(redo, shortcuts.undo, false)).toBe(false)
  })
})

describe("formatShortcut", () => {
  test("writes each platform's own order", () => {
    expect(formatShortcut(shortcuts.save, false)).toBe("Ctrl+S")
    expect(formatShortcut(shortcuts.saveAs, false)).toBe("Ctrl+Shift+S")
    expect(formatShortcut(shortcuts.saveAll, false)).toBe("Ctrl+Alt+S")

    expect(formatShortcut(shortcuts.save, true)).toBe("⌘S")
    expect(formatShortcut(shortcuts.saveAs, true)).toBe("⇧⌘S")
    expect(formatShortcut(shortcuts.saveAll, true)).toBe("⌥⌘S")
  })
})

describe("zoomShortcut", () => {
  test("zooms in from = and from + however it was typed", () => {
    expect(zoomShortcut(keyDown({ ctrlKey: true, key: "=" }), false)).toBe("in")
    expect(zoomShortcut(keyDown({ ctrlKey: true, key: "+", shiftKey: true }), false)).toBe("in")
    expect(zoomShortcut(keyDown({ code: "NumpadAdd", ctrlKey: true, key: "+" }), false)).toBe("in")
  })

  test("zooms out and back to actual size", () => {
    expect(zoomShortcut(keyDown({ ctrlKey: true, key: "-" }), false)).toBe("out")
    expect(zoomShortcut(keyDown({ ctrlKey: true, key: "0" }), false)).toBe("actual-size")
    expect(zoomShortcut(keyDown({ ctrlKey: true, key: "0", shiftKey: true }), false)).toBe("actual-size")
  })

  test("answers only the platform's primary modifier, without Alt", () => {
    expect(zoomShortcut(keyDown({ key: "=" }), false)).toBeNull()
    expect(zoomShortcut(keyDown({ ctrlKey: true, key: "=" }), true)).toBeNull()
    expect(zoomShortcut(keyDown({ key: "=", metaKey: true }), true)).toBe("in")
    expect(zoomShortcut(keyDown({ altKey: true, ctrlKey: true, key: "=" }), false)).toBeNull()
  })
})
