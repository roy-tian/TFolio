import { useMemo, useRef, useState } from "react"

import {
  dismissNotice,
  raiseNotice,
  retractNotices,
  type Notice,
  type NoticeInput,
  type NoticeKind,
  type NoticeOwner,
} from "@/lib/notices"

/** Write-only: what a source needs to say something, and nothing it could read
    the corner with, so no source has to be re-rendered for another's notice. */
export type NoticeChannel = {
  dismiss: (id: string) => void
  raise: (input: NoticeInput) => void
  retract: (owner: NoticeOwner, kinds?: readonly NoticeKind[]) => void
}

/** The channel with one document's name already on it. */
export type DocumentNotices = {
  raise: (kind: NoticeKind, carried?: Omit<NoticeInput, "kind" | "owner">) => void
  retract: (kinds?: readonly NoticeKind[]) => void
}

/** Every notice this window is holding, and the one way to add to them. */
export function useNotices(): { channel: NoticeChannel; notices: Notice[] } {
  const [notices, setNotices] = useState<Notice[]>([])
  const tickRef = useRef(0)

  // One identity for the life of the window: every write goes through the
  // updater, so nothing here closes over the list it is changing.
  const channel = useMemo<NoticeChannel>(
    () => ({
      dismiss: (id) => setNotices((list) => dismissNotice(list, id)),
      raise: (input) => {
        tickRef.current += 1
        const tick = tickRef.current

        setNotices((list) => raiseNotice(list, input, tick))
      },
      retract: (owner, kinds) =>
        setNotices((list) => retractNotices(list, owner, kinds)),
    }),
    [],
  )

  return { channel, notices }
}

/** Binds a session to its own document, so it cannot address another's. */
export function useDocumentNotices(
  channel: NoticeChannel,
  documentId: number,
): DocumentNotices {
  return useMemo(() => {
    const owner: NoticeOwner = { documentId, scope: "document" }

    return {
      raise: (kind, carried) => channel.raise({ ...carried, kind, owner }),
      retract: (kinds) => channel.retract(owner, kinds),
    }
  }, [channel, documentId])
}
