import { samePageNumbersConfig, type PageNumbersConfig } from "@/lib/pageNumbers"
import { fileNameFromPath, type PdfOutlineItem, type PdfPageInfo } from "@/lib/pdf"
import { sameWatermarkConfig, type WatermarkConfig } from "@/lib/watermark"

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
  /** A bookmark for each file with its own bookmarks under it; off, the new
      PDF carries none at all. */
  bookmarks: boolean
  normalizeA4: boolean
  /** Stamped on as the new PDF's own content, not a layer its tab can lift. */
  pageNumbers: PageNumbersConfig | null
  smartPadding: boolean
  watermark: WatermarkConfig | null
}

export type OrganizePlan = {
  groups: OrganizeGroup[]
  /** Slot and group ids, never reused, so a key a drag holds names one thing. */
  nextKey: number
  options: OrganizeOptions
}

export const defaultOrganizeOptions: OrganizeOptions = {
  bookmarks: true,
  normalizeA4: false,
  pageNumbers: null,
  smartPadding: true,
  watermark: null,
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

/** A padding page's group is the one it closes. */
export type OutputPage =
  | { groupId: number; kind: "slot"; slot: Slot }
  | { groupId: number; height: number; kind: "padding"; width: number }

/**
 * The document the plan makes, page by page: groups in order, an empty one
 * contributing nothing, and with smart padding a blank closing any group that
 * would otherwise leave the next to start on an even page. That blank is the
 * back of the group's last leaf, so it is sized like the group's last page.
 */
export function outputPages(plan: OrganizePlan, sources: SourceMap): OutputPage[] {
  const pages: OutputPage[] = []

  for (const group of plan.groups) {
    if (group.slots.length === 0) {
      continue
    }

    const last = pages.at(-1)

    if (plan.options.smartPadding && pages.length % 2 === 1 && last?.kind === "slot") {
      pages.push({
        groupId: last.groupId,
        kind: "padding",
        ...sheetFor(last.slot, sources, plan.options.normalizeA4),
      })
    }

    for (const slot of group.slots) {
      pages.push({ groupId: group.id, kind: "slot", slot })
    }
  }

  return pages
}

/** Padding and inserted blanks alike: the pages no file brought. */
export function blankPageCount(pages: OutputPage[]) {
  return pages.filter((page) => page.kind === "padding" || page.slot.kind === "blank").length
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

/** A file's bookmark as the sidebar shows it and the new PDF gets it. */
export type FileBookmark = {
  items: AssembleOutlineItem[]
  /** Where the file starts; none while it has no pages, when the new PDF
      gets no bookmark for it. */
  pageNumber: number | undefined
  title: string
}

/**
 * Each file's bookmark by group id, in list order, with its source's own
 * bookmarks under it. A source whose own file has no pages left hangs its
 * bookmarks under the file now holding the first page they point at, so every
 * bookmark sits under some file.
 */
export function fileBookmarks(
  plan: OrganizePlan,
  sources: SourceMap,
  pages = outputPages(plan, sources),
): Map<number, FileBookmark> {
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
      const sourcePage = `${sourceId}:${page.slot.pageNumber}`

      // A pasted copy repeats its page: the bookmark keeps the first.
      if (!outputNumber.has(sourcePage)) {
        outputNumber.set(sourcePage, pageNumber)
      }

      if (!firstOfSource.has(sourceId)) {
        firstOfSource.set(sourceId, pageNumber)
      }
    }
  })

  const kept = (sourceId: number) =>
    remappedOutline(
      sources.get(sourceId)?.outline ?? [],
      sourceId,
      outputNumber,
      firstOfSource.get(sourceId),
    )
  const bookmarks = new Map<number, FileBookmark>()
  const placedSources = new Set<number>()

  for (const group of plan.groups) {
    const pageNumber = firstOfGroup.get(group.id)

    if (pageNumber !== undefined) {
      placedSources.add(group.originSourceId)
    }

    bookmarks.set(group.id, {
      items: pageNumber === undefined ? [] : kept(group.originSourceId),
      pageNumber,
      title: group.title,
    })
  }

  const strays = [...firstOfSource.keys()]
    .filter((sourceId) => !placedSources.has(sourceId))
    .map(kept)
    .flatMap((items) => (items[0] ? [{ items, start: items[0].pageNumber }] : []))
    .sort((left, right) => left.start - right.start)

  const strayItems = new Set<AssembleOutlineItem>()

  for (const { items, start } of strays) {
    const page = pages[start - 1]
    const file = page && bookmarks.get(page.groupId)

    if (file) {
      // By page among the file's own, whose order an author may have set
      // against the pages, so those are never re-sorted.
      const at = file.items.findIndex(
        (item) => !strayItems.has(item) && item.pageNumber > start,
      )

      file.items.splice(at === -1 ? file.items.length : at, 0, ...items)
      items.forEach((item) => strayItems.add(item))
    }
  }

  return bookmarks
}

/** The bookmarks the assembled document gets: the sidebar's, written out. */
export function organizeOutline(
  plan: OrganizePlan,
  sources: SourceMap,
  pages = outputPages(plan, sources),
): AssembleOutlineItem[] {
  if (!plan.options.bookmarks) {
    return []
  }

  return [...fileBookmarks(plan, sources, pages).values()].flatMap(
    ({ items, pageNumber, title }) =>
      pageNumber === undefined ? [] : [{ items, pageNumber, title }],
  )
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

/** `added` as the whole list, on the options a new arrangement starts from:
    the old one's were its own PDF's. Keys go on from `plan`'s, never reused:
    the plan replaced may still be an undo away, and a key names one page. */
export function restartPlan(
  plan: OrganizePlan,
  added: OrganizeSource[],
  options: OrganizeOptions,
): OrganizePlan {
  return addSources({ groups: [], nextKey: plan.nextKey, options }, added)
}

export function removeGroups(plan: OrganizePlan, groupIds: ReadonlySet<number>): OrganizePlan {
  return withGroups(
    plan,
    plan.groups.filter((group) => !groupIds.has(group.id)),
  )
}

/** The file's bookmark, also its heading on the board. Blank text keeps the
    title it had: a bookmark needs some. */
export function renameGroup(
  plan: OrganizePlan,
  groupId: number,
  title: string,
): OrganizePlan {
  const text = title.trim()
  const target = plan.groups.find((group) => group.id === groupId)

  if (!target || text === "" || text === target.title) {
    return plan
  }

  return {
    ...plan,
    groups: plan.groups.map((group) => (group === target ? { ...group, title: text } : group)),
  }
}

/** The chosen files, in list order, put together at `to` among the files
    that stay: where the first of them then stands. */
export function moveGroups(
  plan: OrganizePlan,
  groupIds: ReadonlySet<number>,
  to: number,
): OrganizePlan {
  const moving = plan.groups.filter((group) => groupIds.has(group.id))
  const staying = plan.groups.filter((group) => !groupIds.has(group.id))

  return withGroups(plan, spliced(staying, to, 0, ...moving))
}

/** Every page of the chosen files. */
export function groupSlotKeys(
  plan: OrganizePlan,
  groupIds: ReadonlySet<number>,
): Set<number> {
  return new Set(
    plan.groups.flatMap((group) =>
      groupIds.has(group.id) ? group.slots.map((slot) => slot.key) : [],
    ),
  )
}

/** The start of the first chosen file, or the end of the last: a file with
    no pages left still takes what goes beside it. */
export function groupGap(
  plan: OrganizePlan,
  groupIds: ReadonlySet<number>,
  where: "before" | "after",
): { group: OrganizeGroup; index: number } | null {
  const chosen = plan.groups.filter((group) => groupIds.has(group.id))
  const group = where === "before" ? chosen[0] : chosen.at(-1)

  return group ? { group, index: where === "before" ? 0 : group.slots.length } : null
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

/** Copies of the chosen slots, in plan order and under keys of their own, put
    into the target group at `index`. */
export function copySlots(
  plan: OrganizePlan,
  keys: ReadonlySet<number>,
  groupId: number,
  index: number,
): OrganizePlan {
  let nextKey = plan.nextKey
  const copies = plan.groups.flatMap((group) =>
    group.slots.flatMap((slot) => (keys.has(slot.key) ? [{ ...slot, key: nextKey++ }] : [])),
  )

  if (copies.length === 0 || !plan.groups.some((group) => group.id === groupId)) {
    return plan
  }

  return {
    ...plan,
    groups: plan.groups.map((group) =>
      group.id === groupId
        ? { ...group, slots: spliced(group.slots, index, 0, ...copies) }
        : group,
    ),
    nextKey,
  }
}

/** The gap before the first chosen slot, or after the last; with none of them
    on the board, the end of the last group. */
export function slotGap(
  plan: OrganizePlan,
  keys: ReadonlySet<number>,
  where: "before" | "after",
): { group: OrganizeGroup; index: number } | null {
  const located = plan.groups.flatMap((group) =>
    group.slots.flatMap((slot, index) => (keys.has(slot.key) ? [{ group, index }] : [])),
  )
  const at = where === "before" ? located[0] : located.at(-1)

  if (at) {
    return { group: at.group, index: at.index + (where === "after" ? 1 : 0) }
  }

  const last = plan.groups.at(-1)

  return last ? { group: last, index: last.slots.length } : null
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

/** By value: the same layer settings applied again are no edit. */
function sameOptions(left: OrganizeOptions, right: OrganizeOptions) {
  return (
    left.bookmarks === right.bookmarks &&
    left.normalizeA4 === right.normalizeA4 &&
    left.smartPadding === right.smartPadding &&
    samePageNumbersConfig(left.pageNumbers, right.pageNumbers) &&
    sameWatermarkConfig(left.watermark, right.watermark)
  )
}

export function setOptions(plan: OrganizePlan, options: Partial<OrganizeOptions>): OrganizePlan {
  const next = { ...plan.options, ...options }

  return sameOptions(plan.options, next) ? plan : { ...plan, options: next }
}
