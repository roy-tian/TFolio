import { useCallback, useMemo, useRef, useState } from "react"
import { Channel, invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"

import type { NoticeChannel } from "@/hooks/useNotices"
import { e2eOverride } from "@/lib/e2e"
import { workspaceOwner, type NoticeKind } from "@/lib/notices"
import { isWordPath } from "@/lib/openSources"
import {
  addSources,
  assembleSlots,
  deleteSlots,
  emptyPlan,
  insertBlank,
  ORGANIZE_MAX_FILES,
  moveGroup,
  moveSlots,
  organizeOutline,
  outputPages,
  removeGroups,
  rotateSlots,
  setOptions,
  sourceFromInfo,
  type OrganizeOptions,
  type OrganizePlan,
  type OrganizeSource,
  type OrganizeSourceInfo,
} from "@/lib/organize"
import { fileNameFromPath, type PdfDocumentInfo } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"
import { wordConversionAvailable } from "@/lib/wordConversion"

const HISTORY_LIMIT = 100

type History = { future: OrganizePlan[]; past: OrganizePlan[] }

const emptyHistory: History = { future: [], past: [] }

type UseOrganizeWorkspaceOptions = {
  notices: NoticeChannel
  /** Opens the assembled document as a tab of its own, unsaved. */
  onAssembled: (document: PdfDocumentInfo) => void
}

/**
 * The window's one organize workspace: the files it read, the plan of their
 * pages, and that plan's undo history. It outlives switching to the viewer,
 * though not a reload, and touches no open document.
 */
export function useOrganizeWorkspace({
  notices,
  onAssembled,
}: UseOrganizeWorkspaceOptions) {
  const { t } = useTranslation()
  const [sources, setSources] = useState<ReadonlyMap<number, OrganizeSource>>(
    () => new Map(),
  )
  const [plan, setPlan] = useState<OrganizePlan>(emptyPlan)
  const [history, setHistory] = useState<History>(emptyHistory)
  const [selection, setSelection] = useState<ReadonlySet<number>>(() => new Set())
  // Pages a cut has marked to move: they stay where they are until a paste.
  const [cut, setCut] = useState<ReadonlySet<number>>(() => new Set())
  const [adding, setAdding] = useState(false)
  const [assembling, setAssembling] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const [stopping, setStopping] = useState(false)
  // What the handlers read: an add or an edit lands before the render that
  // would refresh a captured value. Written outside any updater, since
  // StrictMode runs an updater twice and a step taken inside would be twice.
  const planRef = useRef(plan)
  const historyRef = useRef(history)
  const sourcesRef = useRef(sources)
  const busyRef = useRef(false)
  const choosingRef = useRef(false)
  // The plan as last assembled: work is unsaved only while the plan differs.
  const assembledRef = useRef<OrganizePlan | null>(null)
  // A Stop pressed before the backend has listed the assembly finds nothing
  // to stop, so each progress report asks again until one listens.
  const stopOwedRef = useRef(false)

  const show = useCallback((next: OrganizePlan, nextHistory: History) => {
    planRef.current = next
    historyRef.current = nextHistory
    setPlan(next)
    setHistory(nextHistory)
  }, [])

  const commit = useCallback(
    (next: OrganizePlan) => {
      const previous = planRef.current

      if (next !== previous) {
        show(next, {
          future: [],
          past: [...historyRef.current.past, previous].slice(-HISTORY_LIMIT),
        })
      }
    },
    [show],
  )

  const undo = useCallback(() => {
    const { future, past } = historyRef.current
    const previous = past.at(-1)

    if (previous && !busyRef.current) {
      show(previous, {
        future: [...future, planRef.current],
        past: past.slice(0, -1),
      })
    }
  }, [show])

  const redo = useCallback(() => {
    const { future, past } = historyRef.current
    const next = future.at(-1)

    if (next && !busyRef.current) {
      show(next, {
        future: future.slice(0, -1),
        past: [...past, planRef.current],
      })
    }
  }, [show])

  const raise = useCallback(
    (kind: NoticeKind, values?: Record<string, string | number>) =>
      notices.raise({ kind, owner: workspaceOwner, values }),
    [notices],
  )

  /** `index` is where the new files go on the list, its end by default. A
      file already on the list is not added again: a second drop of the same
      file is far likelier a slip than a wish for its pages twice. */
  const addPaths = useCallback(
    async (offered: string[], index?: number) => {
      const listed = new Set(
        planRef.current.groups.map(
          (group) => sourcesRef.current.get(group.originSourceId)?.path,
        ),
      )
      const fresh = [...new Set(offered)].filter((path) => !listed.has(path))
      const room = Math.max(0, ORGANIZE_MAX_FILES - planRef.current.groups.length)
      const paths = fresh.slice(0, room)

      if (fresh.length > room) {
        raise("organizeTooManyFiles")
      }

      if (paths.length === 0 || busyRef.current) {
        return
      }

      busyRef.current = true
      setAdding(true)

      // An office suite may take minutes; the corner says so and offers Stop.
      const converting = paths.some(isWordPath)

      if (converting) {
        notices.raise({
          action: { kind: "organizeAddStop" },
          kind: "organizeAdding",
          owner: workspaceOwner,
        })
      }

      try {
        const infos = await invoke<OrganizeSourceInfo[]>("add_organize_sources", {
          paths,
        })
        const added = infos.flatMap((info) => sourceFromInfo(info) ?? [])
        const refused = infos.filter((info) => info.id === undefined)

        if (added.length > 0) {
          const next = new Map(sourcesRef.current)

          for (const source of added) {
            next.set(source.id, source)
          }

          sourcesRef.current = next
          setSources(next)
          commit(addSources(planRef.current, added, index))
        }

        if (refused.length > 0) {
          raise(
            refused.some((info) => info.error === "converterMissing")
              ? "organizeConverterMissing"
              : "organizeUnreadable",
            {
              count: refused.length,
              names: refused.map((info) => fileNameFromPath(info.path)).join(", "),
            },
          )
        }
      } catch (error) {
        raise(
          String(error).includes("at most") ? "organizeTooManyFiles" : "organizeUnreadable",
          { count: paths.length, names: paths.map(fileNameFromPath).join(", ") },
        )
      } finally {
        busyRef.current = false
        setAdding(false)

        if (converting) {
          notices.retract(workspaceOwner, ["organizeAdding"])
        }
      }
    },
    [commit, notices, raise],
  )

  // The backend's own dialog, which is also what approves the chosen paths
  // for reading — see `pick_pdf_paths`.
  const chooseFiles = useCallback(async () => {
    if (choosingRef.current || busyRef.current) {
      return
    }

    choosingRef.current = true

    try {
      const pick = e2eOverride("pickPdfPaths")
      const paths = pick
        ? await pick()
        : await invoke<string[]>("pick_pdf_paths", {
            filterLabel: t(
              wordConversionAvailable()
                ? "organize.sourceFilter"
                : "organize.sourceFilterPlain",
            ),
          })

      await addPaths(paths)
    } catch {
      notices.raise({ kind: "openFailed", owner: workspaceOwner })
    } finally {
      choosingRef.current = false
    }
  }, [addPaths, notices, t])

  const stopAdding = useCallback(() => {
    void invoke("cancel_word_conversion").catch(() => undefined)
  }, [])

  const pages = useMemo(() => outputPages(plan, sources), [plan, sources])
  const outline = useMemo(
    () => organizeOutline(plan, sources, pages),
    [pages, plan, sources],
  )

  const askStop = useCallback(() => {
    void invoke<boolean>("cancel_pdf_merge")
      .then((listened) => {
        if (listened) {
          stopOwedRef.current = false
        }
      })
      .catch(() => undefined)
  }, [])

  const assemble = useCallback(async () => {
    const assembling = planRef.current
    const assembledPages = outputPages(assembling, sourcesRef.current)

    if (busyRef.current || assembledPages.length === 0) {
      return
    }

    busyRef.current = true
    stopOwedRef.current = false
    setAssembling(true)
    setStopping(false)
    setProgress(null)

    const channel = new Channel<PdfProgress>()

    channel.onmessage = (next) => {
      setProgress(next)

      if (stopOwedRef.current) {
        askStop()
      }
    }

    try {
      const document = await invoke<PdfDocumentInfo | null>("assemble_pdf", {
        onProgress: channel,
        plan: {
          normalizeA4: assembling.options.normalizeA4,
          outline: organizeOutline(assembling, sourcesRef.current, assembledPages),
          slots: assembleSlots(assembledPages, assembling.options.normalizeA4),
        },
      })

      if (document) {
        assembledRef.current = assembling
        onAssembled(document)
      }
    } catch (error) {
      const message = String(error)

      raise(
        message.includes("changed since it was added")
          ? "organizeSourceChanged"
          : message.includes("MiB limit")
            ? "fileTooLarge"
            : "organizeFailed",
      )
    } finally {
      busyRef.current = false
      stopOwedRef.current = false
      setAssembling(false)
      setProgress(null)
      setStopping(false)
    }
  }, [askStop, onAssembled, raise])

  const stopAssembling = useCallback(() => {
    setStopping(true)
    stopOwedRef.current = true
    askStop()
  }, [askStop])

  /** An arrangement no PDF has been made of yet — what a close would lose,
      as opposed to work still running. */
  const hasUnsavedArrangementNow = useCallback(
    () =>
      planRef.current.groups.length > 0 &&
      assembledRef.current !== planRef.current,
    [],
  )

  /** Read by the close and update prompts, which run outside a render. */
  const hasUnsavedWorkNow = useCallback(
    () => busyRef.current || hasUnsavedArrangementNow(),
    [hasUnsavedArrangementNow],
  )

  const edit = useCallback(
    (change: (plan: OrganizePlan) => OrganizePlan) => {
      if (!busyRef.current) {
        commit(change(planRef.current))
      }
    },
    [commit],
  )

  const removeFiles = useCallback(
    (groupIds: ReadonlySet<number>) => edit((current) => removeGroups(current, groupIds)),
    [edit],
  )
  const reorderFiles = useCallback(
    (from: number, to: number) => edit((current) => moveGroup(current, from, to)),
    [edit],
  )
  const move = useCallback(
    (keys: ReadonlySet<number>, groupId: number, beforeKey: number | null) =>
      edit((current) => moveSlots(current, keys, groupId, beforeKey)),
    [edit],
  )
  const remove = useCallback(
    (keys: ReadonlySet<number>) => {
      edit((current) => deleteSlots(current, keys))
      setSelection(new Set())
    },
    [edit],
  )
  const rotate = useCallback(
    (keys: ReadonlySet<number>, degrees: 90 | 270) =>
      edit((current) => rotateSlots(current, keys, degrees)),
    [edit],
  )
  const changeOptions = useCallback(
    (options: Partial<OrganizeOptions>) =>
      edit((current) => setOptions(current, options)),
    [edit],
  )

  /** Before the first chosen page, or after the last; with nothing chosen,
      at the end of the last file. */
  const insertBlankAt = useCallback(
    (keys: ReadonlySet<number>, where: "before" | "after") =>
      edit((current) => {
        const located = current.groups.flatMap((group) =>
          group.slots.flatMap((slot, index) =>
            keys.has(slot.key) ? [{ group, index }] : [],
          ),
        )
        const at = where === "before" ? located[0] : located.at(-1)
        const group = at?.group ?? current.groups.at(-1)

        if (!group) {
          return current
        }

        const index = at ? at.index + (where === "after" ? 1 : 0) : group.slots.length

        return insertBlank(current, sourcesRef.current, group.id, index)
      }),
    [edit],
  )

  const selectAll = useCallback(() => {
    setSelection(
      new Set(planRef.current.groups.flatMap((group) => group.slots.map((slot) => slot.key))),
    )
  }, [])

  const cutSelection = useCallback(() => {
    setCut(new Set(selection))
  }, [selection])

  /** The cut pages go before the first chosen page — at the last file's end
      with nothing chosen. Pages cut and still the only ones chosen stay where
      they are: a cut followed straight by a paste moves nothing. */
  const paste = useCallback(() => {
    if (cut.size === 0) {
      return
    }

    const current = planRef.current
    const placed = current.groups.flatMap((group) =>
      group.slots.map((slot) => ({ group, slot })),
    )
    const anchor = placed.find(
      ({ slot }) => selection.has(slot.key) && !cut.has(slot.key),
    )
    const choseOnlyCut =
      !anchor && placed.some(({ slot }) => selection.has(slot.key))
    const group = anchor?.group ?? current.groups.at(-1)

    if (group && !choseOnlyCut) {
      edit((plan) => moveSlots(plan, cut, group.id, anchor?.slot.key ?? null))
    }

    setCut(new Set())
  }, [cut, edit, selection])

  // One object per change rather than per render: the App re-renders often,
  // and a fresh one would re-render the whole board behind the viewer too.
  return useMemo(
    () => ({
      adding,
      addPaths,
      assemble,
      assembling,
      canRedo: history.future.length > 0,
      canUndo: history.past.length > 0,
      changeOptions,
      chooseFiles,
      cut,
      cutSelection,
      hasUnsavedArrangementNow,
      hasUnsavedWorkNow,
      insertBlankAt,
      move,
      outline,
      pages,
      paste,
      plan,
      progress,
      redo,
      remove,
      removeFiles,
      reorderFiles,
      rotate,
      selectAll,
      selection,
      setSelection,
      sources,
      stopAdding,
      stopAssembling,
      stopping,
      undo,
    }),
    [
      adding,
      addPaths,
      assemble,
      assembling,
      changeOptions,
      chooseFiles,
      cut,
      cutSelection,
      hasUnsavedArrangementNow,
      hasUnsavedWorkNow,
      history,
      insertBlankAt,
      move,
      outline,
      pages,
      paste,
      plan,
      progress,
      redo,
      remove,
      removeFiles,
      reorderFiles,
      rotate,
      selectAll,
      selection,
      setSelection,
      sources,
      stopAdding,
      stopAssembling,
      stopping,
      undo,
    ],
  )
}

export type OrganizeWorkspace = ReturnType<typeof useOrganizeWorkspace>
