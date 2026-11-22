import { describe, expect, test } from "bun:test"

import {
  createSingleFlightGate,
  FILE_DIALOG_BUSY,
  isFileDialogBusyError,
} from "@/lib/fileDialogGate"

describe("createSingleFlightGate", () => {
  test("allows only one active holder at a time", () => {
    const gate = createSingleFlightGate()

    expect(gate.isActive()).toBe(false)

    const releaseFirst = gate.acquire()
    expect(releaseFirst).not.toBeNull()
    expect(gate.isActive()).toBe(true)
    expect(gate.acquire()).toBeNull()

    releaseFirst!()
    expect(gate.isActive()).toBe(false)

    const releaseSecond = gate.acquire()
    expect(releaseSecond).not.toBeNull()
    releaseSecond!()
    expect(gate.isActive()).toBe(false)
  })

  test("an extra release from a prior holder does not drop a newer holder's lock", () => {
    const gate = createSingleFlightGate()
    const releaseFirst = gate.acquire()!
    releaseFirst()

    const releaseSecond = gate.acquire()!
    // Simulates an outer `finally` running after an inner release already
    // handed control to a follow-up Save As (such as `saveForClose`).
    releaseFirst()

    expect(gate.isActive()).toBe(true)
    expect(gate.acquire()).toBeNull()

    releaseSecond()
    expect(gate.isActive()).toBe(false)
  })

  test("recognizes the backend busy sentinel error", () => {
    expect(isFileDialogBusyError(FILE_DIALOG_BUSY)).toBe(true)
    expect(isFileDialogBusyError(new Error(FILE_DIALOG_BUSY))).toBe(true)
    expect(isFileDialogBusyError("disk full")).toBe(false)
  })
})
