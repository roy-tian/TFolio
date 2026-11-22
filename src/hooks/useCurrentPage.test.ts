import { describe, expect, test } from "bun:test"

import { createCurrentPage } from "@/hooks/useCurrentPage"

describe("createCurrentPage", () => {
  test("bumps jumpCount only on goTo, never on set, reland, or renumbered", () => {
    const page = createCurrentPage(1)

    expect(page.jumpCount()).toBe(0)
    page.set(2)
    expect(page.jumpCount()).toBe(0)

    page.goTo(2)
    expect(page.jumpCount()).toBe(1)
    expect(page.jump?.page).toBe(2)

    page.reland()
    expect(page.jumpCount()).toBe(1)

    page.renumbered(3, true)
    expect(page.jumpCount()).toBe(1)
    expect(page.get()).toBe(3)
  })

  test("reland(pageNumber) restores an expired jump without bumping jumpCount", () => {
    const page = createCurrentPage(1)
    let notifications = 0
    page.subscribe(() => {
      notifications += 1
    })

    page.goTo(5)
    expect(page.jumpCount()).toBe(1)
    // Simulates the tracker expiring the jump after JUMP_ARRIVAL_MS and
    // reverting currentPage before delayed search highlights mount.
    page.jump = null
    page.set(2)
    expect(page.get()).toBe(2)

    const before = notifications
    page.reland(5)

    expect(page.get()).toBe(5)
    expect(page.jump).toMatchObject({ landedTop: null, page: 5 })
    expect(page.jumpCount()).toBe(1)
    expect(notifications).toBe(before + 1)

    // Without a target page, reland remains a no-op once the jump has gone.
    page.jump = null
    const after = notifications
    page.reland()
    expect(page.jump).toBeNull()
    expect(notifications).toBe(after)
  })
})
