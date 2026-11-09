import { useCallback, useRef, useState } from "react"

import type { NoticeKind } from "@/lib/notices"
import { documentFileChanged } from "@/lib/openFiles"

/** What opening a file already in a tab comes to: the tab to show — that one,
    or the one a reload put in its place — and any refusal along the way. */
export type Reopened = { error: NoticeKind | null; id: number | null }

type ReopenTabOptions<Context> = {
  hasUnsavedWork: (documentId: number) => boolean
  /** Replaces the tab with a fresh open of its file, keeping it on failure.
      `confirm` runs once the file is read, right before the swap: the tab
      stayed editable through the read, so false keeps it after all. */
  reload: (
    documentId: number,
    context: Context,
    confirm: () => Promise<boolean>,
  ) => Promise<Reopened>
  /** Brings the tab forward, so the question is plainly about it. */
  show: (documentId: number) => void
  /** The tab's name, or null where it has gone. */
  tabName: (documentId: number) => string | null
}

/** An open of a file already in a tab shows that tab, unless something else
    has written the file since: then a tab with nothing to lose reloads it,
    and one with unsaved work asks first. The callbacks must be stable. */
export function useReopenTab<Context>({
  hasUnsavedWork,
  reload,
  show,
  tabName,
}: ReopenTabOptions<Context>) {
  // Kept after an answer, so the prompt keeps its words while it fades out.
  const [name, setName] = useState("")
  const [open, setOpen] = useState(false)
  const resolveRef = useRef<((reload: boolean) => void) | null>(null)

  // A second ask while one is open keeps its tab: the dialog is modal.
  const ask = useCallback((tab: string) => {
    if (resolveRef.current) {
      return Promise.resolve(false)
    }

    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setName(tab)
      setOpen(true)
    })
  }, [])

  const answer = useCallback((value: boolean) => {
    const resolve = resolveRef.current

    resolveRef.current = null
    setOpen(false)
    resolve?.(value)
  }, [])

  const reopen = useCallback(
    async (documentId: number, context: Context): Promise<Reopened> => {
      const tab = tabName(documentId)

      if (tab === null) {
        return { error: null, id: null }
      }

      if (!(await documentFileChanged(documentId))) {
        return { error: null, id: documentId }
      }

      // A discard once agreed stands; otherwise asked wherever work exists,
      // including work begun while the file was being read.
      let discarding = false
      const confirm = async () => {
        if (discarding || !hasUnsavedWork(documentId)) {
          return true
        }

        show(documentId)
        discarding = await ask(tab)

        return discarding
      }

      if (!(await confirm())) {
        return { error: null, id: documentId }
      }

      return reload(documentId, context, confirm)
    },
    [ask, hasUnsavedWork, reload, show, tabName],
  )

  return { answer, name, open, reopen }
}
