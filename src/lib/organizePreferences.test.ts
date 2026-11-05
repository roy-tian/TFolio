import { describe, expect, test } from "bun:test"

import { organizePreferencesOf } from "./organizePreferences"

describe("organizePreferencesOf", () => {
  test("keeps the choices the file holds", () => {
    expect(
      organizePreferencesOf({ bookmarks: false, normalizeA4: true, smartPadding: false }),
    ).toEqual({ bookmarks: false, normalizeA4: true, smartPadding: false })
  })

  test("falls back choice by choice on what is missing or not a boolean", () => {
    expect(organizePreferencesOf({ normalizeA4: "yes", smartPadding: false })).toEqual({
      bookmarks: true,
      normalizeA4: false,
      smartPadding: false,
    })
    expect(organizePreferencesOf(undefined)).toEqual({
      bookmarks: true,
      normalizeA4: false,
      smartPadding: true,
    })
  })
})
