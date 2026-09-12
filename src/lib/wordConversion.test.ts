import { describe, expect, it } from "bun:test"

import {
  loadWordConversionAvailability,
  wordConversionAvailable,
} from "@/lib/wordConversion"

/**
 * The gate goes through the real IPC seam, so what these assert is what
 * `word_conversion_available` would actually answer.
 */
async function withBackend(
  answer: () => boolean | Error,
  body: () => void | Promise<void>,
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          if (command !== "word_conversion_available") {
            return Promise.reject(new Error(`unexpected command: ${command}`))
          }

          const answered = answer()

          return answered instanceof Error
            ? Promise.reject(answered)
            : Promise.resolve(answered)
        },
      },
    },
  })

  try {
    await body()
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
}

describe("wordConversion", () => {
  it("keeps the door closed when the backend cannot answer", async () => {
    // Runs first because a closed door is the module's own starting state:
    // a failed ask must leave it where it found it, not half-open it.
    await withBackend(() => new Error("no backend"), async () => {
      await loadWordConversionAvailability()

      expect(wordConversionAvailable()).toBe(false)
    })
  })

  it("opens the wizard's Word promise when a suite was detected", async () => {
    await withBackend(() => true, async () => {
      await loadWordConversionAvailability()

      expect(wordConversionAvailable()).toBe(true)
    })
  })

  it("closes it again when none was", async () => {
    await withBackend(() => false, async () => {
      await loadWordConversionAvailability()

      expect(wordConversionAvailable()).toBe(false)
    })
  })
})
