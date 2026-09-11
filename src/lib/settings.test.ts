import { describe, expect, it } from "bun:test"

import {
  loadSettings,
  rememberSettings,
  storedSettings,
  wordConversionEnabled,
} from "@/lib/settings"

type Stub = {
  /** Every document `set_settings` was handed, in order. */
  written: unknown[]
  storage: Map<string, string>
}

/**
 * Runs `body` against a stubbed backend and a stubbed WebView storage, then
 * puts `window` back. The settings go through the real IPC seam, so what these
 * assert is what `settings.rs` would actually be sent.
 */
async function withBackend(
  stored: unknown,
  body: (stub: Stub) => void | Promise<void>,
  { failsToLoad = false, failsToWrite = false } = {},
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const stub: Stub = { storage: new Map(), written: [] }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: { settings?: unknown }) => {
          if (command === "settings") {
            return failsToLoad
              ? Promise.reject(new Error("no backend"))
              : Promise.resolve(stored)
          }

          stub.written.push(structuredClone(args?.settings))

          return failsToWrite
            ? Promise.reject(new Error("nowhere to write it"))
            : Promise.resolve(null)
        },
      },
      localStorage: {
        // Enough of the real thing for `Object.keys` to see the stored keys.
        get length() {
          return stub.storage.size
        },
        key: (index: number) => [...stub.storage.keys()][index] ?? null,
        getItem: (key: string) => stub.storage.get(key) ?? null,
        removeItem: (key: string) => stub.storage.delete(key),
        setItem: (key: string, value: string) => stub.storage.set(key, value),
      },
    },
  })

  try {
    await body(stub)
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
}

describe("settings", () => {
  it("folds a patch into the section it names and leaves the rest", async () => {
    await withBackend(
      { ui: { language: "en", theme: "dark" }, pageNumbers: { mode: "single" } },
      async (stub) => {
        await loadSettings()
        await rememberSettings({ ui: { viewMode: "book" } })

        expect(stub.written.at(-1)).toEqual({
          pageNumbers: { mode: "single" },
          ui: { language: "en", theme: "dark", viewMode: "book" },
        })
      },
    )
  })

  it("answers the Word conversion setting only as the boolean it is", async () => {
    // Absent is the default — on — and anything the file may have drifted
    // into is not read as a refusal the reader never made.
    await withBackend(null, async () => {
      await loadSettings()

      expect(wordConversionEnabled()).toBe(true)
    })

    await withBackend({ import: { wordConversion: false } }, async () => {
      await loadSettings()

      expect(wordConversionEnabled()).toBe(false)
    })

    await withBackend({ import: { wordConversion: "no" } }, async () => {
      await loadSettings()

      expect(wordConversionEnabled()).toBe(true)
    })
  })

  it("folds an import patch into the section it names", async () => {
    // A sibling field the current version does not know still survives the
    // write: the section merges by field, like ui and annotate.
    await withBackend(
      { import: { wordConversion: true, somedayField: "keep" } },
      async (stub) => {
        await loadSettings()
        await rememberSettings({ import: { wordConversion: false } })

        expect(stub.written.at(-1)).toEqual({
          import: { somedayField: "keep", wordConversion: false },
        })
      },
    )
  })

  it("replaces a setting's own value whole", async () => {
    // Half a style is not a style: a remembered mark is the one the reader
    // applied, never that one crossed with the last.
    await withBackend({ watermark: { layout: "zebra", text: "老的" } }, async (stub) => {
      await loadSettings()
      await rememberSettings({ watermark: { text: "新的" } })

      expect(stub.written.at(-1)).toEqual({ watermark: { text: "新的" } })
    })
  })

  it("writes nothing until the file has actually been read", async () => {
    // Otherwise the first setting the reader touches would write a copy of this
    // module's own defaults over everything the file holds.
    await withBackend(
      null,
      async (stub) => {
        await loadSettings()
        await rememberSettings({ ui: { theme: "dark" } })

        expect(stub.written).toEqual([])
      },
      { failsToLoad: true },
    )
  })

  it("adopts what the replaced storage keys held, and clears them", async () => {
    await withBackend({ ui: { theme: "light" } }, async (stub) => {
      stub.storage.set("tfolio.ui.theme", "dark")
      stub.storage.set("tfolio.ui.language", "en")
      stub.storage.set("tfolio.annotate.rectStyle", '{"color":"#ffffff"}')
      stub.storage.set("tfolio.annotate.textNoteStyle", "{ not json")
      // An older schema's key, which nothing here reads and nothing should keep.
      stub.storage.set("tfolio.annotate.watermarkStyle", "{}")

      await loadSettings()

      expect(storedSettings()).toEqual({
        annotate: { rect: { color: "#ffffff" } },
        // The file wins over the key it replaced, being the later of the two.
        ui: { language: "en", theme: "light" },
      })
      expect(stub.written).toHaveLength(1)
      expect(stub.storage.size).toBe(0)
    })
  })

  it("leaves the storage keys alone when it could not read the file", async () => {
    // They are the only copy left; a run that cannot move them must not be the
    // run that drops them.
    await withBackend(
      null,
      async (stub) => {
        stub.storage.set("tfolio.ui.theme", "dark")

        await loadSettings()

        expect(stub.storage.get("tfolio.ui.theme")).toBe("dark")
      },
      { failsToLoad: true },
    )
  })

  it("leaves the storage keys alone when the file would not take them", async () => {
    // The same rule at the other end of the move: read but not written down is
    // still not moved.
    await withBackend(
      {},
      async (stub) => {
        stub.storage.set("tfolio.ui.theme", "dark")

        await loadSettings()

        expect(stub.written).toHaveLength(1)
        expect(stub.storage.get("tfolio.ui.theme")).toBe("dark")
      },
      { failsToWrite: true },
    )
  })
})
