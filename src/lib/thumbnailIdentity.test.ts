import { describe, expect, it } from "bun:test"

import {
  followPages,
  forgetStashes,
  initialThumbnailIdentity,
} from "@/lib/thumbnailIdentity"

describe("followPages", () => {
  it("keeps each page's key through a delete and parks the deleted ones", () => {
    const deleted = followPages(initialThumbnailIdentity(5), 3, {
      movement: [1, 3, 5],
      stashId: 7,
    })

    expect(deleted.keys).toEqual([0, 2, 4])
    expect(deleted.parked.get(7)).toEqual([1, 3])
  })

  it("hands an undo its pages' own keys back, out of the stash they went into", () => {
    const deleted = followPages(initialThumbnailIdentity(5), 3, {
      movement: [1, 3, 5],
      stashId: 7,
    })
    const restored = followPages(deleted, 5, {
      movement: [1, null, 2, null, 3],
      stashId: 7,
    })

    expect(restored.keys).toEqual([0, 1, 2, 3, 4])
    expect(restored.parked.size).toBe(0)
    expect(restored.nextKey).toBe(5)
  })

  it("gives a page new to the document a fresh key", () => {
    const pasted = followPages(initialThumbnailIdentity(2), 4, {
      movement: [1, null, null, 2],
      stashId: 3,
    })

    expect(pasted.keys).toEqual([0, 2, 3, 1])
    expect(pasted.nextKey).toBe(4)
    expect(pasted.parked.size).toBe(0)
  })

  it("moves keys with a reorder and leaves a turn alone", () => {
    const identity = initialThumbnailIdentity(3)

    expect(followPages(identity, 3, { movement: [3, 1, 2] }).keys).toEqual([2, 0, 1])
    expect(followPages(identity, 3, { movement: "inPlace" })).toBe(identity)
  })

  it("keeps keys by position without a change to go by", () => {
    const longer = followPages(initialThumbnailIdentity(3), 4)

    expect(longer.keys).toEqual([0, 1, 2, 3])
    expect(longer.nextKey).toBe(4)
  })
})

describe("forgetStashes", () => {
  it("drops the keys of stashes the history let go of", () => {
    const identity = followPages(initialThumbnailIdentity(3), 2, {
      movement: [1, 3],
      stashId: 4,
    })

    expect(identity.parked.get(4)).toEqual([1])
    expect(forgetStashes(identity, [9])).toBe(identity)
    expect(forgetStashes(identity, [4]).parked.size).toBe(0)
  })
})
