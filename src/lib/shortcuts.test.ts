import { describe, expect, test } from "bun:test"

import {
  formatShortcut,
  matchesShortcut,
  shortcuts,
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
