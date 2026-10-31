import { fileNameFromPath, type PdfOutlineItem, type PdfPageInfo } from "@/lib/pdf"

/** A4 in points, portrait. */
const A4 = { height: 841.89, width: 595.28 }
const A4_LANDSCAPE = { height: A4.width, width: A4.height }

export type OrganizeSourceKind = "pdf" | "image" | "word"

/** A file the workspace read: its pages as they were, never edited. */
export type OrganizeSource = {
  id: number
  kind: OrganizeSourceKind
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
  path: string
  /** The file name without its extension: a bookmark's title. */
  title: string
}

/** `turn` is clockwise, on top of the page's own rotation. */
export type PageSlot = {
  key: number
  kind: "page"
  pageNumber: number
  sourceId: number
  turn: number
}

export type BlankSlot = { height: number; key: number; kind: "blank"; width: number }

export type Slot = PageSlot | BlankSlot

/** A file on the list: where its pages go together, and its bookmark. */
export type OrganizeGroup = {
  id: number
  /** The source it was added as, whose own bookmarks it carries. */
  originSourceId: number
  slots: Slot[]
  title: string
}

export type OrganizeOptions = {
  fileBookmarks: boolean
  keepBookmarks: boolean
  normalizeA4: boolean
  smartPadding: boolean
}

export type OrganizePlan = {
  groups: OrganizeGroup[]
  /** Slot and group ids, never reused, so a key a drag holds names one thing. */
  nextKey: number
  options: OrganizeOptions
}

export const defaultOrganizeOptions: OrganizeOptions = {
  fileBookmarks: true,
  keepBookmarks: false,
  normalizeA4: false,
  smartPadding: false,
}

export const emptyPlan: OrganizePlan = {
  groups: [],
  nextKey: 1,
  options: defaultOrganizeOptions,
}

export type SourceMap = ReadonlyMap<number, OrganizeSource>

/** Mirrors `MAX_MERGE_FILES` in `io.rs`, which refuses a larger single add;
    this one counts the files on the list, across adds. */
export const ORGANIZE_MAX_FILES = 64

/** The plan itself where an edit changed no group, so the history takes no
    step for it and an assembled plan does not read as changed. */
function withGroups(plan: OrganizePlan, groups: OrganizeGroup[]): OrganizePlan {
  const unchanged =
    groups.length === plan.groups.length &&
    groups.every((group, index) => {
      const before = plan.groups[index]!

      return (
        group === before ||
        (group.id === before.id &&
          group.slots.length === before.slots.length &&
          group.slots.every((slot, at) => slot === before.slots[at]))
      )
    })

  return unchanged ? plan : { ...plan, groups }
}

/** `toSpliced`, which the ES2022 library this app builds against lacks. */
function spliced<T>(items: readonly T[], start: number, remove: number, ...added: T[]) {
  const copy = items.slice()

  copy.splice(start, remove, ...added)
  return copy
}

/** What `add_organize_sources` answers per file; no `id` is a file that could
    not be read, `error` saying why where "unreadable" would understate it. */
export type OrganizeSourceInfo = {
  error?: "converterMissing" | "conversionFailed"
  id?: number
  kind: OrganizeSourceKind
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
  path: string
}

export function sourceFromInfo(info: OrganizeSourceInfo): OrganizeSource | null {
  if (info.id === undefined || info.pages.length === 0) {
    return null
  }

  const name = fileNameFromPath(info.path)
  const dot = name.lastIndexOf(".")

  return {
    id: info.id,
    kind: info.kind,
    outline: info.outline,
    pages: info.pages,
    path: info.path,
    title: dot > 0 ? name.slice(0, dot) : name,
  }
}

/** The page as it will stand: its displayed size with the turn applied. */
export function slotSize(slot: Slot, sources: SourceMap) {
  if (slot.kind === "blank") {
    return { height: slot.height, width: slot.width }
  }

  const page = sources.get(slot.sourceId)?.pages[slot.pageNumber - 1]
  const width = page?.width ?? A4.width
  const height = page?.height ?? A4.height

  return slot.turn % 180 === 0 ? { height, width } : { height: width, width: height }
}

/** A blank's sheet: on A4, turned the way its planned shape is, as the
    engine's `append_blanks` turns it. */
function blankSheet(size: { height: number; width: number }, normalizeA4: boolean) {
  if (!normalizeA4) {
    return { height: size.height, width: size.width }
  }

  return size.width > size.height ? A4_LANDSCAPE : A4
}

/** Mirrors `a4_placement` in `geometry.rs`: upright unless lying the sheet
    down shrinks the page less — a page that fits either way stays upright. */
function fittedA4(page: { height: number; width: number }) {
  const fit = (sheetWidth: number, sheetHeight: number) =>
    Math.min(sheetWidth / page.width, sheetHeight / page.height, 1)

  return fit(A4.height, A4.width) > fit(A4.width, A4.height) ? A4_LANDSCAPE : A4
}

/** The sheet a slot will stand on, which a padding page or a new blank beside
    it copies. The engine fits a page as it reads, then applies the turn, so
    the sheet turns with it rather than being chosen by the turned shape. */
function sheetFor(slot: Slot, sources: SourceMap, normalizeA4: boolean) {
  if (slot.kind === "blank" || !normalizeA4) {
    return blankSheet(slotSize(slot, sources), normalizeA4)
  }

  const sheet = fittedA4(slotSize({ ...slot, turn: 0 }, sources))

  return slot.turn % 180 === 0 ? sheet : { height: sheet.width, width: sheet.height }
}

export type OutputPage =
  | { groupId: number; kind: "slot"; slot: Slot }
  | { groupId: number; height: number; kind: "padding"; width: number }

/**
 * The document the plan makes, page by page: groups in order, an empty one
 * contributing nothing, and with smart padding a blank before any group that
 * would otherwise start on an even page, sized like that group's first page.
 */
export function outputPages(plan: OrganizePlan, sources: SourceMap): OutputPage[] {
  const pages: OutputPage[] = []

  for (const group of plan.groups) {
    const first = group.slots[0]

    if (!first) {
      continue
    }

    if (plan.options.smartPadding && pages.length % 2 === 1) {
      pages.push({
        groupId: group.id,
        kind: "padding",
        ...sheetFor(first, sources, plan.options.normalizeA4),
      })
    }

    for (const slot of group.slots) {
      pages.push({ groupId: group.id, kind: "slot", slot })
    }
  }

  return pages
}

export type AssembleSlot =
  | { kind: "page"; pageNumber: number; sourceId: number; turn: number }
  | { height: number; kind: "blank"; width: number }

export type AssembleOutlineItem = {
  items: AssembleOutlineItem[]
  pageNumber: number
  title: string
}

export function assembleSlots(pages: OutputPage[], normalizeA4: boolean): AssembleSlot[] {
  return pages.map((page) => {
    if (page.kind === "padding") {
      return { height: page.height, kind: "blank", width: page.width }
    }

    const { slot } = page

    return slot.kind === "page"
      ? {
          kind: "page",
          pageNumber: slot.pageNumber,
          sourceId: slot.sourceId,
          turn: slot.turn,
        }
      : { kind: "blank", ...blankSheet(slot, normalizeA4) }
  })
}

/**
 * A source's bookmarks moved onto the pages they now point at, wherever the
 * reader took them. A bookmark whose page is gone goes too, its children taking
 * its place; one with no page of its own points at its file's first page left.
 */
function remappedOutline(
  items: PdfOutlineItem[],
  sourceId: number,
  outputNumber: ReadonlyMap<string, number>,
  firstOfSource: number | undefined,
): AssembleOutlineItem[] {
  return items.flatMap((item) => {
    const children = remappedOutline(item.items, sourceId, outputNumber, firstOfSource)
    const pageNumber =
      item.pageNumber === undefined || item.pageNumber === null
        ? firstOfSource
        : outputNumber.get(`${sourceId}:${item.pageNumber}`)

    return pageNumber === undefined
      ? children
      : [{ items: children, pageNumber, title: item.title }]
  })
}

/** The bookmarks the assembled document gets, as the sidebar previews them. */
export function organizeOutline(
  plan: OrganizePlan,
  sources: SourceMap,
  pages = outputPages(plan, sources),
): AssembleOutlineItem[] {
  const { fileBookmarks, keepBookmarks } = plan.options

  if (!fileBookmarks && !keepBookmarks) {
    return []
  }

  const outputNumber = new Map<string, number>()
  const firstOfSource = new Map<number, number>()
  const firstOfGroup = new Map<number, number>()

  pages.forEach((page, index) => {
    const pageNumber = index + 1

    if (page.kind === "slot" && !firstOfGroup.has(page.groupId)) {
      firstOfGroup.set(page.groupId, pageNumber)
    }

    if (page.kind === "slot" && page.slot.kind === "page") {
      const { sourceId } = page.slot

      outputNumber.set(`${sourceId}:${page.slot.pageNumber}`, pageNumber)

      if (!firstOfSource.has(sourceId)) {
        firstOfSource.set(sourceId, pageNumber)
      }
    }
  })

  const kept = (sourceId: number) =>
    keepBookmarks
      ? remappedOutline(
          sources.get(sourceId)?.outline ?? [],
          sourceId,
          outputNumber,
          firstOfSource.get(sourceId),
        )
      : []

  // Placed by the page each part starts on: a group by its first page, the
  // bookmarks of a source whose own group is gone by the first they point at.
  const parts: Array<{ items: AssembleOutlineItem[]; start: number }> = []
  const placedSources = new Set<number>()

  for (const group of plan.groups) {
    const start = firstOfGroup.get(group.id)

    if (start === undefined) {
      continue
    }

    placedSources.add(group.originSourceId)

    const own = kept(group.originSourceId)

    parts.push({
      items: fileBookmarks
        ? [{ items: own, pageNumber: start, title: group.title }]
        : own,
      start,
    })
  }

  for (const sourceId of firstOfSource.keys()) {
    if (placedSources.has(sourceId)) {
      continue
    }

    const items = kept(sourceId)
    const first = items[0]

    if (first) {
      parts.push({ items, start: first.pageNumber })
    }
  }

  return parts
    .sort((left, right) => left.start - right.start)
    .flatMap((part) => part.items)
}

/** Each source as a group of its own, in the given order, at `index`. */
export function addSources(
  plan: OrganizePlan,
  added: OrganizeSource[],
  index = plan.groups.length,
): OrganizePlan {
  let nextKey = plan.nextKey
  const take = () => nextKey++
  const groups = added.map((source) => ({
    id: take(),
    originSourceId: source.id,
    slots: source.pages.map((_, page) => ({
      key: take(),
      kind: "page" as const,
      pageNumber: page + 1,
      sourceId: source.id,
      turn: 0,
    })),
    title: source.title,
  }))

  return {
    ...plan,
    groups: spliced(plan.groups, index, 0, ...groups),
    nextKey,
  }
}

export function removeGroups(plan: OrganizePlan, groupIds: ReadonlySet<number>): OrganizePlan {
  return withGroups(
    plan,
    plan.groups.filter((group) => !groupIds.has(group.id)),
  )
}

export function moveGroup(plan: OrganizePlan, from: number, to: number): OrganizePlan {
  const moved = plan.groups[from]

  if (!moved || from === to) {
    return plan
  }

  return {
    ...plan,
    groups: spliced(spliced(plan.groups, from, 1), to, 0, moved),
  }
}

/**
 * Takes the chosen slots out wherever they are and puts them, in plan order,
 * into the target group before the slot `beforeKey` names — at its end where
 * that is null. A key that is itself moving cannot be the anchor.
 */
export function moveSlots(
  plan: OrganizePlan,
  keys: ReadonlySet<number>,
  groupId: number,
  beforeKey: number | null,
): OrganizePlan {
  if (keys.size === 0 || (beforeKey !== null && keys.has(beforeKey))) {
    return plan
  }

  const moving = plan.groups.flatMap((group) =>
    group.slots.filter((slot) => keys.has(slot.key)),
  )
  const groups = plan.groups.map((group) => {
    const kept = group.slots.filter((slot) => !keys.has(slot.key))

    if (group.id !== groupId) {
      return kept.length === group.slots.length ? group : { ...group, slots: kept }
    }

    const at = beforeKey === null ? kept.length : kept.findIndex((slot) => slot.key === beforeKey)

    return { ...group, slots: spliced(kept, at < 0 ? kept.length : at, 0, ...moving) }
  })

  return withGroups(plan, groups)
}

export function deleteSlots(plan: OrganizePlan, keys: ReadonlySet<number>): OrganizePlan {
  return withGroups(
    plan,
    plan.groups.map((group) =>
      group.slots.some((slot) => keys.has(slot.key))
        ? { ...group, slots: group.slots.filter((slot) => !keys.has(slot.key)) }
        : group,
    ),
  )
}

/** A blank turns by trading its sides, as a turned page's footprint does. */
export function rotateSlots(
  plan: OrganizePlan,
  keys: ReadonlySet<number>,
  degrees: 90 | 270,
): OrganizePlan {
  return withGroups(
    plan,
    plan.groups.map((group) =>
      group.slots.some((slot) => keys.has(slot.key))
        ? {
            ...group,
            slots: group.slots.map((slot) => {
              if (!keys.has(slot.key)) {
                return slot
              }

              return slot.kind === "page"
                ? { ...slot, turn: (slot.turn + degrees) % 360 }
                : { ...slot, height: slot.width, width: slot.height }
            }),
          }
        : group,
    ),
  )
}

/** Sized like the page it lands before — or after, at a group's end. */
export function insertBlank(
  plan: OrganizePlan,
  sources: SourceMap,
  groupId: number,
  index: number,
): OrganizePlan {
  if (!plan.groups.some((group) => group.id === groupId)) {
    return plan
  }

  let nextKey = plan.nextKey
  const groups = plan.groups.map((group) => {
    if (group.id !== groupId) {
      return group
    }

    const neighbour = group.slots[index] ?? group.slots[index - 1]
    const size = neighbour ? sheetFor(neighbour, sources, plan.options.normalizeA4) : A4

    return {
      ...group,
      slots: spliced(group.slots, index, 0, {
        key: nextKey++,
        kind: "blank" as const,
        ...size,
      }),
    }
  })

  return { ...plan, groups, nextKey }
}

export function setOptions(plan: OrganizePlan, options: Partial<OrganizeOptions>): OrganizePlan {
  const changed = (Object.keys(options) as Array<keyof OrganizeOptions>).some(
    (name) => options[name] !== undefined && options[name] !== plan.options[name],
  )

  return changed ? { ...plan, options: { ...plan.options, ...options } } : plan
}
