import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Channel, invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"

import type { NoticeChannel } from "@/hooks/useNotices"
import type { AskSignatures } from "@/hooks/useSignaturePrompt"
import { isNoteFontMissing } from "@/lib/annotationStyles"
import { e2eOverride } from "@/lib/e2e"
import { storedSignatureHandling } from "@/lib/signatureHandling"
import { usesEmbeddedFont } from "@/lib/embeddedFont"
import { workspaceOwner, type NoticeKind } from "@/lib/notices"
import { isWordPath } from "@/lib/openSources"
import {
  addSources,
  assembleSlots,
  copySlots,
  deleteSlots,
  emptyPlan,
  fileBookmarks,
  groupGap,
  groupSlotKeys,
  insertBlank,
  ORGANIZE_MAX_FILES,
  moveGroups,
  moveSlots,
  organizeOutline,
  outputPages,
  removeGroups,
  renameGroup,
  restartPlan,
  rotateSlots,
  setOptions,
  slotGap,
  sourceFromInfo,
  type OrganizeGroup,
  type OrganizeOptions,
  type OrganizePlan,
  type OrganizeSource,
  type OrganizeSourceInfo,
} from "@/lib/organize"
import {
  storedOrganizePreferences,
  storeOrganizePreferences,
  type OrganizePreferences,
} from "@/lib/organizePreferences"
import { pageNumbersFit } from "@/lib/pageNumbers"
import {
  exportFailureNotice,
  fileNameFromPath,
  type PdfDocumentInfo,
  type SignatureDecision,
} from "@/lib/pdf"
import type { PdfLayerOutcome, PdfProgress } from "@/lib/progress"
import { subscribeSettings } from "@/lib/settings"
import { wordConversionAvailable } from "@/lib/wordConversion"

const HISTORY_LIMIT = 100

type History = { future: OrganizePlan[]; past: OrganizePlan[] }

const emptyHistory: History = { future: [], past: [] }

/** Where a new arrangement starts: the reader's last choices, read afresh
    since another window may have made them, and no layers. */
function startingOptions(): OrganizeOptions {
  return { ...emptyPlan.options, ...storedOrganizePreferences() }
}

type FontOffer = "noteFontFailed" | "noteFontMissing"

/** The layer options a dialog sets: one PDF's, never kept as preferences. */
export type OrganizeLayerOptions = Partial<Pick<OrganizeOptions, "pageNumbers" | "watermark">>

/** Slot keys, which outlive every edit: a page copied or cut is still the one
    taken however the pages move before the paste. */
type OrganizeClipboard = { keys: ReadonlySet<number>; mode: "cut" | "copy" }

const NO_KEYS: ReadonlySet<number> = new Set()

type UseOrganizeWorkspaceOptions = {
  /** The window's one signature prompt, for pages taken from signed files. */
  askSignatures: AskSignatures
  notices: NoticeChannel
  /** Opens the assembled document as the tab of the file it was saved to. */
  onAssembled: (document: PdfDocumentInfo) => void
}

/**
 * The window's one organize workspace: the files it read, the plan of their
 * pages, and that plan's undo history. It outlives switching to the viewer,
 * though not a reload, and touches no open document.
 */
export function useOrganizeWorkspace({
  askSignatures,
  notices,
  onAssembled,
}: UseOrganizeWorkspaceOptions) {
  const { t } = useTranslation()
  const [sources, setSources] = useState<ReadonlyMap<number, OrganizeSource>>(
    () => new Map(),
  )
  const [plan, setPlan] = useState<OrganizePlan>(() => ({
    ...emptyPlan,
    options: startingOptions(),
  }))
  const [history, setHistory] = useState<History>(emptyHistory)
  // Pages or files, never both: choosing one lets go of the other, so the
  // toolbar and the keys act on whichever was chosen last.
  const [selection, setPageSelection] = useState<ReadonlySet<number>>(() => new Set())
  // Group ids. One an edit took off the list stays here unshown, so the undo
  // bringing its file back brings it back chosen.
  const [storedFiles, setStoredFiles] = useState<ReadonlySet<number>>(NO_KEYS)
  const [clipboard, setClipboard] = useState<OrganizeClipboard | null>(null)
  // Pages a cut has marked to move: they stay where they are until a paste.
  const cut = clipboard?.mode === "cut" ? clipboard.keys : NO_KEYS
  const [adding, setAdding] = useState(false)
  const [assembling, setAssembling] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const [stopping, setStopping] = useState(false)
  const [fontOffer, setFontOffer] = useState<FontOffer | null>(null)
  const [fetchingFont, setFetchingFont] = useState(false)
  const fetchingFontRef = useRef(false)
  // Which offer a fetch in flight answers: one dismissed meanwhile stays gone.
  const fontOfferRef = useRef(0)
  // Bumped by each new arrangement, so a mark checked for the old one is not
  // put on the files that replaced it.
  const restartsRef = useRef(0)
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
  // The plan a fill from the viewer's tab left, and what it read: the reader
  // has changed nothing while the plan is still this one.
  const baselineRef = useRef(plan)
  const baselineKeyRef = useRef<string | null>(null)
  // A Stop pressed before the backend has listed the assembly finds nothing
  // to stop, so each progress report asks again until one listens.
  const stopOwedRef = useRef(false)

  const setSelection = useCallback((next: ReadonlySet<number>) => {
    setPageSelection(next)

    if (next.size > 0) {
      setStoredFiles(NO_KEYS)
    }
  }, [])

  const setFileSelection = useCallback((next: ReadonlySet<number>) => {
    setStoredFiles(next)

    if (next.size > 0) {
      setPageSelection(NO_KEYS)
    }
  }, [])

  const offerFont = useCallback((next: FontOffer | null) => {
    fontOfferRef.current += 1
    setFontOffer(next)
  }, [])

  const clearChoices = useCallback(() => {
    setPageSelection(NO_KEYS)
    setStoredFiles(NO_KEYS)
  }, [])

  const fileSelection = useMemo(() => {
    const listed = plan.groups.flatMap((group) =>
      storedFiles.has(group.id) ? [group.id] : [],
    )

    return listed.length === storedFiles.size ? storedFiles : new Set(listed)
  }, [plan.groups, storedFiles])

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

  /** Reads `paths` as sources and hands `place` those it could read. */
  const load = useCallback(
    async (paths: string[], place: (added: OrganizeSource[]) => void) => {
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
          place(added)
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
    [notices, raise],
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

      if (fresh.length > room) {
        raise("organizeTooManyFiles")
      }

      await load(fresh.slice(0, room), (added) =>
        commit(addSources(planRef.current, added, index)),
      )
    },
    [commit, load, raise],
  )

  /** Untouched is empty, or just as a fill left it: nothing the reader did is
      there to lose, so another file may take its place. A redo stack is the
      reader's own work an undo stepped back from, which a fill would drop. */
  const isUntouchedNow = useCallback(
    () =>
      historyRef.current.future.length === 0 &&
      (planRef.current.groups.length === 0 || planRef.current === baselineRef.current),
    [],
  )

  /** An add or assembly under way, which refuses any other change. */
  const isBusyNow = useCallback(() => busyRef.current, [])

  /** What the shown fill was read from, while the reader has left it alone. */
  const filledKeyNow = useCallback(
    () =>
      planRef.current.groups.length > 0 && planRef.current === baselineRef.current
        ? baselineKeyRef.current
        : null,
    [],
  )

  /** A fill is the workspace's starting point, not an edit: it takes no undo
      step unless an undo history stands, which it must not wipe. */
  const showUntouched = useCallback(
    (next: OrganizePlan, key: string | null) => {
      const { future, past } = historyRef.current
      const kept = past.length > 0 || future.length > 0

      restartsRef.current += 1
      baselineRef.current = next
      baselineKeyRef.current = key
      clearChoices()
      setClipboard(null)
      show(
        next,
        kept
          ? { future: [], past: [...past, planRef.current].slice(-HISTORY_LIMIT) }
          : emptyHistory,
      )
    },
    [clearChoices, show],
  )

  /** Shows `path` alone as untouched, `key` naming what was read. */
  const fill = useCallback(
    (path: string, key: string | null) =>
      load([path], (added) =>
        showUntouched(restartPlan(planRef.current, added, startingOptions()), key),
      ),
    [load, showUntouched],
  )

  /** Empties an untouched workspace: what it holds is not the file now shown. */
  const clearUntouched = useCallback(() => {
    if (!busyRef.current && planRef.current.groups.length > 0 && isUntouchedNow()) {
      showUntouched(restartPlan(planRef.current, [], startingOptions()), null)
    }
  }, [isUntouchedNow, showUntouched])

  /** `paths` as the whole list, one undo away from what it held. */
  const startOver = useCallback(
    async (offered: string[]) => {
      const paths = [...new Set(offered)]

      if (paths.length > ORGANIZE_MAX_FILES) {
        raise("organizeTooManyFiles")
      }

      await load(paths.slice(0, ORGANIZE_MAX_FILES), (added) => {
        restartsRef.current += 1
        clearChoices()
        setClipboard(null)
        commit(restartPlan(planRef.current, added, startingOptions()))
      })
    },
    [clearChoices, commit, load, raise],
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
  const bookmarks = useMemo(
    () => fileBookmarks(plan, sources, pages),
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

  /** Asks where the PDF goes first, and opens it as the file written there. */
  const assemble = useCallback(async () => {
    const assembling = planRef.current
    const assembledPages = outputPages(assembling, sourcesRef.current)
    const { normalizeA4, pageNumbers, watermark } = assembling.options

    if (busyRef.current || assembledPages.length === 0) {
      return
    }

    // A range set before pages were removed would only fail the build.
    if (pageNumbers && !pageNumbersFit(pageNumbers, assembledPages.length)) {
      raise("organizePageNumbersStale")
      return
    }

    // A new PDF keeps no signature of the files it takes pages from; the
    // reader says first what becomes of them, and the backend holds it to that.
    const signedSources = new Set(
      assembledPages.flatMap((page) =>
        page.kind === "slot" &&
        page.slot.kind === "page" &&
        sourcesRef.current.get(page.slot.sourceId)?.signatures.intact
          ? [page.slot.sourceId]
          : [],
      ),
    )
    let signatures: SignatureDecision | null = null
    // Announced only once the PDF exists: a cancelled dialog changed nothing.
    let settledAs: SignatureDecision | null = null

    if (signedSources.size > 0) {
      const remembered = storedSignatureHandling()

      signatures =
        remembered === "ask"
          ? await askSignatures({
              context: "organize",
              count: signedSources.size,
              name: "",
            })
          : remembered

      if (!signatures) {
        return
      }

      if (remembered !== "ask") {
        settledAs = remembered
      }
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
      const args = {
        filterLabel: t("annotate.exportFilter"),
        onProgress: channel,
        plan: {
          normalizeA4,
          outline: organizeOutline(assembling, sourcesRef.current, assembledPages),
          pageNumbers,
          signatures,
          slots: assembleSlots(assembledPages, normalizeA4),
          watermark,
        },
        suggestedName: t("organize.untitled"),
      }
      const override = e2eOverride("saveAssembledPdf")
      const document = override
        ? await override(args)
        : await invoke<PdfDocumentInfo | null>("save_assembled_pdf", args)

      if (document) {
        assembledRef.current = assembling
        onAssembled(document)

        if (settledAs) {
          raise(settledAs === "flatten" ? "signaturesFlattenedAsSet" : "signaturesKeptAsSet")
        }
      }
    } catch (error) {
      // The face could have gone since the mark was checked; the save is
      // the reader's to try again once one is fetched.
      if (isNoteFontMissing(error)) {
        offerFont("noteFontMissing")
        return
      }

      const message = String(error)
      const refusal = exportFailureNotice(error)

      raise(
        refusal !== "exportFailed"
          ? refusal
          : message.includes("changed since it was added")
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
  }, [askSignatures, askStop, offerFont, onAssembled, raise, t])

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
      assembledRef.current !== planRef.current &&
      baselineRef.current !== planRef.current,
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
  // Taken while busy too, where `edit` refuses: a field may be open as an add
  // starts, and no add or assembly under way reads a title it did not start with.
  const renameFile = useCallback(
    (groupId: number, title: string) =>
      commit(renameGroup(planRef.current, groupId, title)),
    [commit],
  )
  const moveFiles = useCallback(
    (groupIds: ReadonlySet<number>, to: number) =>
      edit((current) => moveGroups(current, groupIds, to)),
    [edit],
  )
  const move = useCallback(
    (keys: ReadonlySet<number>, groupId: number, beforeKey: number | null) =>
      edit((current) => moveSlots(current, keys, groupId, beforeKey)),
    [edit],
  )
  const remove = useCallback(
    (keys: ReadonlySet<number>) => {
      // A refused delete leaves its pages chosen.
      if (busyRef.current) {
        return
      }

      edit((current) => deleteSlots(current, keys))
      // A page's own delete button may leave the rest of the selection standing.
      setPageSelection((current) => new Set([...current].filter((key) => !keys.has(key))))
    },
    [edit],
  )
  const rotate = useCallback(
    (keys: ReadonlySet<number>, degrees: 90 | 270) =>
      edit((current) => rotateSlots(current, keys, degrees)),
    [edit],
  )
  /** A choice the reader makes is also where the next plan starts; an undo
      steps this plan back, not that. */
  const changeOptions = useCallback(
    (options: Partial<OrganizeOptions>) => {
      if (busyRef.current) {
        return
      }

      edit((current) => setOptions(current, options))
      storeOrganizePreferences(options)
    },
    [edit],
  )

  /** A layer dialog's apply. Taken while busy too, as a rename is: a dialog
      may be open as an add starts, and no add or save under way reads options
      it did not start with. A mark no installed face can draw is refused with
      the viewer's offer to fetch one, and the dialog stays for a retry. */
  const setLayers = useCallback(
    async (layers: OrganizeLayerOptions): Promise<PdfLayerOutcome> => {
      const { watermark } = layers
      const restarts = restartsRef.current

      if (watermark && usesEmbeddedFont(watermark.text)) {
        try {
          await invoke("check_organize_watermark", { config: watermark })
        } catch (error) {
          // Any other refusal is the save's to report, where it would recur.
          if (isNoteFontMissing(error)) {
            offerFont("noteFontMissing")
            return "failed"
          }
        }
      }

      // The arrangement it was set for is gone: nothing to apply it to.
      if (restarts !== restartsRef.current) {
        return "cancelled"
      }

      offerFont(null)
      commit(setOptions(planRef.current, layers))
      return "applied"
    },
    [commit, offerFont],
  )

  /** Fetches the face the offer names; the reader applies or saves again. */
  const fetchFont = useCallback(async () => {
    if (fetchingFontRef.current) {
      return
    }

    const offer = fontOfferRef.current

    fetchingFontRef.current = true
    setFetchingFont(true)

    try {
      await invoke("download_pdf_note_font")

      if (offer === fontOfferRef.current) {
        setFontOffer(null)
      }
    } catch {
      if (offer === fontOfferRef.current) {
        setFontOffer("noteFontFailed")
      }
    } finally {
      fetchingFontRef.current = false
      setFetchingFont(false)
    }
  }, [])

  const dismissFontOffer = useCallback(() => offerFont(null), [offerFont])

  // A condition, not an event, as in the viewer: raised again whenever its
  // button changes, which only updates the standing notice.
  useEffect(() => {
    if (fontOffer) {
      notices.raise({
        action: { busy: fetchingFont, kind: "noteFont" },
        kind: fontOffer,
        owner: workspaceOwner,
      })
    } else {
      notices.retract(workspaceOwner, ["noteFontFailed", "noteFontMissing"])
    }
  }, [fetchingFont, fontOffer, notices])

  // An empty workspace shows what the next arrangement starts from, so it
  // follows a choice another window makes; not an edit, so no undo step. Only
  // the choices that changed: any other write must not override an undo.
  useEffect(() => {
    let read = storedOrganizePreferences()

    return subscribeSettings(() => {
      const previous = read
      const current = planRef.current

      read = storedOrganizePreferences()

      if (current.groups.length > 0) {
        return
      }

      const changed = Object.fromEntries(
        Object.entries(read).filter(
          ([name, value]) => previous[name as keyof OrganizePreferences] !== value,
        ),
      )
      const next = setOptions(current, changed)

      if (next !== current) {
        if (baselineRef.current === current) {
          baselineRef.current = next
        }

        planRef.current = next
        setPlan(next)
      }
    })
  }, [])

  /** Before the first chosen page, or after the last; with nothing chosen,
      at the end of the last file. */
  const insertBlankAt = useCallback(
    (keys: ReadonlySet<number>, where: "before" | "after") =>
      edit((current) => {
        const gap = slotGap(current, keys, where)

        return gap
          ? insertBlank(current, sourcesRef.current, gap.group.id, gap.index)
          : current
      }),
    [edit],
  )

  /** Before the first chosen page or file, or after the last. */
  const insertBlankBeside = useCallback(
    (where: "before" | "after") =>
      edit((current) => {
        const gap =
          fileSelection.size > 0
            ? groupGap(current, fileSelection, where)
            : slotGap(current, selection, where)

        return gap
          ? insertBlank(current, sourcesRef.current, gap.group.id, gap.index)
          : current
      }),
    [edit, fileSelection, selection],
  )

  /** The chosen pages, or every page of the chosen files. */
  const rotateChosen = useCallback(
    (degrees: 90 | 270) =>
      rotate(
        fileSelection.size > 0 ? groupSlotKeys(planRef.current, fileSelection) : selection,
        degrees,
      ),
    [fileSelection, rotate, selection],
  )

  /** The chosen files come off the list whole, chosen pages out of theirs. */
  const removeChosen = useCallback(() => {
    if (fileSelection.size > 0) {
      removeFiles(fileSelection)
    } else if (selection.size > 0) {
      remove(selection)
    }
  }, [fileSelection, remove, removeFiles, selection])

  const selectAll = useCallback(() => {
    setSelection(
      new Set(planRef.current.groups.flatMap((group) => group.slots.map((slot) => slot.key))),
    )
  }, [setSelection])

  /** The chosen pages, or every page of the chosen files. */
  const take = useCallback(
    (mode: OrganizeClipboard["mode"]) => {
      const keys =
        fileSelection.size > 0
          ? groupSlotKeys(planRef.current, fileSelection)
          : new Set(selection)

      if (keys.size > 0) {
        setClipboard({ keys, mode })
      }
    },
    [fileSelection, selection],
  )
  const cutSelection = useCallback(() => take("cut"), [take])
  const copySelection = useCallback(() => take("copy"), [take])
  /** A copy stays on the clipboard for the next paste; Esc only lets go of a
      cut, the one that shows. */
  const cancelCut = useCallback(() => {
    setClipboard((current) => (current?.mode === "cut" ? null : current))
  }, [])

  /** Into `group` at `index`: a cut lands in front of the first page there
      that is not itself moving, which a page in hand cannot anchor. */
  const pasteInto = useCallback(
    (group: OrganizeGroup, index: number) => {
      // Busy, `edit` refuses the paste: a cut must outlive it.
      if (!clipboard || busyRef.current) {
        return
      }

      const { keys, mode } = clipboard

      if (mode === "copy") {
        edit((plan) => copySlots(plan, keys, group.id, index))
        return
      }

      const beforeKey =
        group.slots.slice(index).find((slot) => !keys.has(slot.key))?.key ?? null

      edit((plan) => moveSlots(plan, keys, group.id, beforeKey))
      setClipboard(null)
    },
    [clipboard, edit],
  )

  /** The keyboard's paste: before the first chosen page not itself cut, or at
      the end of the last chosen file — of the last file with nothing chosen.
      Pages cut and still all that is chosen, or all the chosen files hold,
      stay where they are: a cut followed straight by a paste moves nothing. */
  const paste = useCallback(() => {
    const current = planRef.current
    const chosen = current.groups.flatMap((group) =>
      group.slots.flatMap((slot, index) =>
        selection.has(slot.key) ? [{ group, index, key: slot.key }] : [],
      ),
    )
    const anchor = chosen.find(({ key }) => !cut.has(key))
    const end = groupGap(current, fileSelection, "after")
    const held = groupSlotKeys(current, fileSelection)
    const heldAllCut = held.size > 0 && [...held].every((key) => cut.has(key))
    const last = current.groups.at(-1)

    if (anchor) {
      pasteInto(anchor.group, anchor.index)
    } else if (chosen.length > 0 || heldAllCut) {
      setClipboard(null)
    } else if (end) {
      pasteInto(end.group, end.index)
    } else if (last) {
      pasteInto(last, last.slots.length)
    }
  }, [cut, fileSelection, pasteInto, selection])

  /** The menu's paste, beside the pages it was opened on. */
  const pasteBeside = useCallback(
    (keys: ReadonlySet<number>, where: "before" | "after") => {
      const gap = slotGap(planRef.current, keys, where)

      if (gap) {
        pasteInto(gap.group, gap.index)
      }
    },
    [pasteInto],
  )

  // One object per change rather than per render: the App re-renders often,
  // and a fresh one would re-render the whole board behind the viewer too.
  return useMemo(
    () => ({
      adding,
      addPaths,
      assemble,
      assembling,
      bookmarks,
      canRedo: history.future.length > 0,
      canUndo: history.past.length > 0,
      changeOptions,
      cancelCut,
      clearChoices,
      // Not once every page it took has been deleted: its paste would do nothing.
      canPaste:
        clipboard !== null &&
        plan.groups.some((group) => group.slots.some((slot) => clipboard.keys.has(slot.key))),
      chooseFiles,
      clearUntouched,
      copySelection,
      cut,
      cutSelection,
      dismissFontOffer,
      fetchFont,
      fileSelection,
      fill,
      filledKeyNow,
      hasUnsavedArrangementNow,
      hasUnsavedWorkNow,
      insertBlankAt,
      insertBlankBeside,
      isBusyNow,
      isUntouchedNow,
      move,
      moveFiles,
      pages,
      paste,
      pasteBeside,
      plan,
      progress,
      redo,
      remove,
      removeChosen,
      removeFiles,
      renameFile,
      rotate,
      rotateChosen,
      selectAll,
      selection,
      setFileSelection,
      setLayers,
      setSelection,
      sources,
      startOver,
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
      bookmarks,
      cancelCut,
      changeOptions,
      chooseFiles,
      clearChoices,
      clearUntouched,
      clipboard,
      copySelection,
      cut,
      cutSelection,
      dismissFontOffer,
      fetchFont,
      fileSelection,
      fill,
      filledKeyNow,
      hasUnsavedArrangementNow,
      hasUnsavedWorkNow,
      history,
      insertBlankAt,
      insertBlankBeside,
      isBusyNow,
      isUntouchedNow,
      move,
      moveFiles,
      pages,
      paste,
      pasteBeside,
      plan,
      progress,
      redo,
      remove,
      removeChosen,
      removeFiles,
      renameFile,
      rotate,
      rotateChosen,
      selectAll,
      selection,
      setFileSelection,
      setLayers,
      setSelection,
      sources,
      startOver,
      stopAdding,
      stopAssembling,
      stopping,
      undo,
    ],
  )
}

export type OrganizeWorkspace = ReturnType<typeof useOrganizeWorkspace>
