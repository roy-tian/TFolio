import { describe, expect, test } from "bun:test"

import { isMacOSUserAgent } from "./platform"

describe("isMacOSUserAgent", () => {
  test("recognises macOS WebView user agents", () => {
    expect(
      isMacOSUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      ),
    ).toBe(true)
  })

  test("does not classify Windows or Linux WebViews as macOS", () => {
    expect(
      isMacOSUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ),
    ).toBe(false)
    expect(
      isMacOSUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
      ),
    ).toBe(false)
  })
})
