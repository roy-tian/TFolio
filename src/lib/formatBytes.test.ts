import { describe, expect, test } from "bun:test"

import { formatBytes } from "@/lib/formatBytes"

describe("formatBytes", () => {
  test("counts whole bytes below one KiB", () => {
    expect(formatBytes(0, "en")).toBe("0 B")
    expect(formatBytes(512, "en")).toBe("512 B")
  })

  test("carries one fraction digit into the larger units", () => {
    expect(formatBytes(1024, "en")).toBe("1.0 KiB")
    expect(formatBytes(8.5 * 1024 * 1024, "en")).toBe("8.5 MiB")
  })

  test("drops the fraction once the number is wide enough", () => {
    expect(formatBytes(123 * 1024, "en")).toBe("123 KiB")
    expect(formatBytes(1.2 * 1024 ** 3, "en")).toBe("1.2 GiB")
  })

  test("writes the UI language's decimal separator", () => {
    expect(formatBytes(8.5 * 1024 * 1024, "de")).toBe("8,5 MiB")
    expect(formatBytes(8.5 * 1024 * 1024, "th")).toBe("8.5 MiB")
  })

  test("stops at GiB rather than inventing a unit", () => {
    expect(formatBytes(9 * 1024 ** 4, "en")).toBe("9216 GiB")
  })
})
