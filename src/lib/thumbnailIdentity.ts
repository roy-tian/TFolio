import type { PageChange } from "@/lib/annotations"

/** Which preview stands for each page. Keys follow their pages through every
    structure edit; a page taken out leaves its key in the edit's stash, for the
    undo or redo that brings the same page back to take up again. */
export type ThumbnailIdentity = {
  keys: number[]
  nextKey: number
  /** By stash id, the keys of the pages it holds, in page order. */
  parked: ReadonlyMap<number, number[]>
}

export function initialThumbnailIdentity(pageCount: number): ThumbnailIdentity {
  return {
    keys: Array.from({ length: pageCount }, (_, index) => index),
    nextKey: pageCount,
    parked: new Map(),
  }
}

/** The keys after a structure edit left `pageCount` pages. Without a change to
    go by, a position keeps its preview. */
export function followPages(
  identity: ThumbnailIdentity,
  pageCount: number,
  change?: PageChange,
): ThumbnailIdentity {
  const movement = change?.movement

  if (movement === "inPlace") {
    return identity
  }

  const { keys } = identity
  const stashId = change?.stashId
  const parked = new Map(identity.parked)
  const returning = stashId === undefined ? [] : [...(parked.get(stashId) ?? [])]
  let nextKey = identity.nextKey
  const next = Array.from({ length: pageCount }, (_, index) => {
    const from = movement ? movement[index] : index + 1

    if (from === null) {
      return returning.shift() ?? nextKey++
    }

    return (from === undefined ? undefined : keys[from - 1]) ?? nextKey++
  })
  const staying = new Set(next)
  const left = keys.filter((key) => !staying.has(key))

  if (stashId !== undefined) {
    parked.delete(stashId)

    if (left.length > 0) {
      parked.set(stashId, left)
    }
  }

  return { keys: next, nextKey, parked }
}

/** Without the stashes the history has let go of: their pages cannot come back. */
export function forgetStashes(
  identity: ThumbnailIdentity,
  stashIds: readonly number[],
): ThumbnailIdentity {
  if (!stashIds.some((stashId) => identity.parked.has(stashId))) {
    return identity
  }

  const parked = new Map(identity.parked)

  for (const stashId of stashIds) {
    parked.delete(stashId)
  }

  return { ...identity, parked }
}
