import { describe, expect, it } from "bun:test"

import {
  canRedo,
  canUndo,
  commandPages,
  commit,
  emptyHistory,
  historyHead,
  isDirty,
  markSaved,
  redo,
  undo,
  type AnnotationCommand,
  type AnnotationHistory,
} from "@/lib/annotations"

function highlight(...pageNumbers: number[]): AnnotationCommand {
  return {
    color: "#ffd54a",
    kind: "highlight",
    opacity: 0.4,
    targets: pageNumbers.map((pageNumber) => ({
      pageNumber,
      quads: [{ height: 10, left: 0, top: 0, width: 50 }],
    })),
  }
}

/** Applies each command in turn, as a reader drawing them one after another. */
function historyOf(...commands: AnnotationCommand[]): AnnotationHistory {
  return commands.reduce(commit, emptyHistory)
}

describe("commandPages", () => {
  it("reports the page a single-page command writes to", () => {
    expect(commandPages(highlight(3))).toEqual([3])
  })

  // A selection dragged across a page break is one action, so its command
  // carries every page it touched and an undo has to take all of them back.
  it("reports every page a selection ran across", () => {
    expect(commandPages(highlight(3, 4))).toEqual([3, 4])
  })
})

describe("commit", () => {
  it("applies a command", () => {
    const history = historyOf(highlight(1))

    expect(history.past).toHaveLength(1)
    expect(canUndo(history)).toBe(true)
    expect(canRedo(history)).toBe(false)
  })

  it("gives each command its own identity", () => {
    const history = historyOf(highlight(1), highlight(1))

    expect(history.past[0]!.id).not.toBe(history.past[1]!.id)
  })

  // Drawing after an undo takes a new branch; the old one is gone for good and
  // must not be reachable by pressing redo.
  it("drops anything undone", () => {
    const undone = undo(historyOf(highlight(1)))!.history

    expect(canRedo(undone)).toBe(true)
    expect(canRedo(commit(undone, highlight(2)))).toBe(false)
  })
})

describe("undo and redo", () => {
  it("reports nothing to undo on an untouched document", () => {
    expect(undo(emptyHistory)).toBeNull()
    expect(canUndo(emptyHistory)).toBe(false)
  })

  it("reports nothing to redo until something is undone", () => {
    expect(redo(historyOf(highlight(1)))).toBeNull()
  })

  it("takes back the most recent command first", () => {
    const history = historyOf(highlight(1), highlight(2))
    const undone = undo(history)!

    expect(commandPages(undone.entry.command)).toEqual([2])
    expect(undone.history.past).toHaveLength(1)
  })

  it("re-applies the most recently undone command", () => {
    const undone = undo(historyOf(highlight(1), highlight(2)))!
    const redone = redo(undone.history)!

    expect(commandPages(redone.entry.command)).toEqual([2])
    expect(redone.history.past).toHaveLength(2)
  })

  // Redoing re-runs the command and gets a fresh annotation out of PDFium, but
  // it is still the same entry in the reader's history.
  it("keeps an entry's identity across an undo and redo", () => {
    const history = historyOf(highlight(1))
    const id = historyHead(history)
    const restored = redo(undo(history)!.history)!

    expect(restored.entry.id).toBe(id)
    expect(historyHead(restored.history)).toBe(id)
  })

  it("winds a whole document back and forward again", () => {
    const history = historyOf(highlight(1), highlight(2), highlight(3))
    let wound = history

    for (let step = 0; step < 3; step += 1) {
      wound = undo(wound)!.history
    }

    expect(canUndo(wound)).toBe(false)
    expect(wound.past).toHaveLength(0)

    for (let step = 0; step < 3; step += 1) {
      wound = redo(wound)!.history
    }

    expect(canRedo(wound)).toBe(false)
    expect(wound.past.map((entry) => entry.id)).toEqual(
      history.past.map((entry) => entry.id),
    )
  })
})

describe("isDirty", () => {
  it("reports a freshly opened document clean", () => {
    expect(isDirty(emptyHistory)).toBe(false)
  })

  it("reports a drawn-on document dirty", () => {
    expect(isDirty(historyOf(highlight(1)))).toBe(true)
  })

  it("reports a saved document clean", () => {
    expect(isDirty(markSaved(historyOf(highlight(1))))).toBe(false)
  })

  it("reports a document drawn on after a save dirty", () => {
    const saved = markSaved(historyOf(highlight(1)))

    expect(isDirty(commit(saved, highlight(2)))).toBe(true)
  })

  // Undoing past a save leaves the document holding less than the file does,
  // which is still a difference the reader may want to write out.
  it("reports a document undone past its save dirty", () => {
    const saved = markSaved(historyOf(highlight(1)))

    expect(isDirty(undo(saved)!.history)).toBe(true)
  })

  // The case a plain edit counter gets wrong: winding back to exactly what was
  // saved leaves the document matching the file, so there is nothing to write.
  it("reports a document undone back to its save clean", () => {
    const saved = markSaved(historyOf(highlight(1)))
    const drawn = commit(saved, highlight(2))

    expect(isDirty(undo(drawn)!.history)).toBe(false)
  })

  it("reports a document redone back to its save clean", () => {
    const history = markSaved(historyOf(highlight(1), highlight(2)))
    const wound = redo(undo(history)!.history)!.history

    expect(isDirty(wound)).toBe(false)
  })
})
