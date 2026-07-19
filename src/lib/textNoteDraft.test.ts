import { describe, expect, test } from "bun:test"

import { defaultTextNoteStyle } from "@/lib/annotationStyles"
import {
  clampNoteText,
  isNoteWorthKeeping,
  noteDraftToCommand,
  startNoteDraft,
  TEXT_NOTE_MAX_CHARS,
  TEXT_NOTE_MAX_LINES,
  usesEmbeddedFont,
} from "@/lib/textNoteDraft"

describe("isNoteWorthKeeping", () => {
  test("keeps a note with words in it", () => {
    expect(isNoteWorthKeeping("Hello")).toBe(true)
    expect(isNoteWorthKeeping("  padded  ")).toBe(true)
  })

  test("drops one the reader never typed in", () => {
    expect(isNoteWorthKeeping("")).toBe(false)
    expect(isNoteWorthKeeping("   ")).toBe(false)
    expect(isNoteWorthKeeping("\n\n  \n")).toBe(false)
  })
})

describe("usesEmbeddedFont", () => {
  test("leaves text a standard PDF font can draw alone", () => {
    expect(usesEmbeddedFont("Hello, world!")).toBe(false)
    expect(usesEmbeddedFont("two\nlines")).toBe(false)
    expect(usesEmbeddedFont("Voilà, café")).toBe(false)
    expect(usesEmbeddedFont("")).toBe(false)
  })

  test("claims text that leaves Latin-1", () => {
    expect(usesEmbeddedFont("你好")).toBe(true)
    expect(usesEmbeddedFont("Hello 你好")).toBe(true)
    expect(usesEmbeddedFont("，")).toBe(true)
    expect(usesEmbeddedFont("Привет")).toBe(true)
    // Reads as Western text but is outside Latin-1 all the same.
    expect(usesEmbeddedFont("a — b")).toBe(true)
  })

  test("agrees with the backend on the boundary itself", () => {
    // The two ends of each range the Rust side accepts, and the gap between
    // them — where the two could most easily drift apart.
    expect(usesEmbeddedFont("\u0020\u007e")).toBe(false)
    expect(usesEmbeddedFont("\u00a0\u00ff")).toBe(false)
    // The gap between the two ranges, which neither side may quietly widen.
    expect(usesEmbeddedFont("\u007f")).toBe(true)
    expect(usesEmbeddedFont("\u009f")).toBe(true)
    expect(usesEmbeddedFont("\u0100")).toBe(true)
  })
})

describe("clampNoteText", () => {
  test("leaves a note inside the limits untouched", () => {
    expect(clampNoteText("Hello")).toBe("Hello")
  })

  test("cuts a note to the character ceiling", () => {
    expect(clampNoteText("a".repeat(TEXT_NOTE_MAX_CHARS + 10))).toHaveLength(
      TEXT_NOTE_MAX_CHARS,
    )
  })

  test("counts code points, not UTF-16 units", () => {
    // An astral character is two units and one `char` to Rust, so a limit
    // measured in units would cut a Chinese note at half its allowance.
    const clamped = clampNoteText("𝄞".repeat(TEXT_NOTE_MAX_CHARS + 10))

    expect([...clamped]).toHaveLength(TEXT_NOTE_MAX_CHARS)
  })

  test("cuts a note to the line ceiling", () => {
    const clamped = clampNoteText("x\n".repeat(TEXT_NOTE_MAX_LINES + 10))

    expect(clamped.split("\n")).toHaveLength(TEXT_NOTE_MAX_LINES)
  })
})

describe("noteDraftToCommand", () => {
  const draftAt = (text: string) => ({
    ...startNoteDraft(3, { left: 20, top: 40 }),
    text,
  })

  test("carries the draft's place and the current style", () => {
    expect(noteDraftToCommand(draftAt("Hello"), defaultTextNoteStyle)).toEqual({
      kind: "textNote",
      origin: { left: 20, top: 40 },
      pageNumber: 3,
      style: defaultTextNoteStyle,
      text: "Hello",
    })
  })

  test("drops trailing blank lines rather than boxing empty space", () => {
    expect(
      noteDraftToCommand(draftAt("Hello\n\n  "), defaultTextNoteStyle)?.text,
    ).toBe("Hello")
  })

  test("keeps the blank lines a reader put between paragraphs", () => {
    expect(
      noteDraftToCommand(draftAt("One\n\nTwo"), defaultTextNoteStyle)?.text,
    ).toBe("One\n\nTwo")
  })

  test("refuses a note with nothing in it", () => {
    expect(noteDraftToCommand(draftAt("   \n "), defaultTextNoteStyle)).toBeNull()
  })
})
