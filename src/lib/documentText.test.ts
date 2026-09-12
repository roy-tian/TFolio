import { describe, expect, it } from "bun:test"

import { documentPlainText } from "@/lib/documentText"

type Stub = {
  asked: number[]
}

async function withPageText(
  pages: (string | null)[],
  body: (stub: Stub) => Promise<void>,
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const stub: Stub = { asked: [] }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: { pageNumber?: number }) => {
          if (command !== "extract_pdf_page_plain_text") {
            return Promise.reject(new Error(`unexpected command ${command}`))
          }

          const pageNumber = args?.pageNumber ?? 0
          stub.asked.push(pageNumber)

          const text = pages[pageNumber - 1]

          return text === null || text === undefined
            ? Promise.reject(new Error("no such page"))
            : Promise.resolve(text)
        },
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

describe("documentPlainText", () => {
  it("joins every page in order, one page at a time", async () => {
    await withPageText(["first", "second", "third"], async (stub) => {
      expect(await documentPlainText(7, 3)).toBe("first\n\nsecond\n\nthird")
      expect(stub.asked).toEqual([1, 2, 3])
    })
  })

  it("takes CRLF down to the one line ending", async () => {
    await withPageText(["a\r\nb\rc\n"], async () => {
      expect(await documentPlainText(7, 1)).toBe("a\nb\nc")
    })
  })

  it("skips pages holding no text at all", async () => {
    await withPageText(["first", "   \r\n", "third"], async () => {
      expect(await documentPlainText(7, 3)).toBe("first\n\nthird")
    })
  })

  it("leaves out a page the backend refuses rather than losing the rest", async () => {
    await withPageText(["first", null, "third"], async () => {
      expect(await documentPlainText(7, 3)).toBe("first\n\nthird")
    })
  })
})
