import { useEffect } from "react"
import type { TOptions } from "i18next"
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { OperationProgress } from "@/components/OperationProgress"
import { Button } from "@/components/ui/button"
import {
  NOTICE_LIFE_MS,
  isPageNotice,
  noticeActions,
  noticeCatalogue,
  noticeClockKey,
  overflowNotices,
  visibleNotices,
  type Notice,
  type NoticeTone,
} from "@/lib/notices"
import { cn } from "@/lib/utils"

/** Every tone but the plain one carries its colour in the words as well as the
    border: a border alone is too quiet to tell good news from a bare report,
    which is the whole difference between a finished download and a copied page. */
const toneClasses: Record<NoticeTone, string> = {
  danger: "border-destructive/40 text-destructive",
  info: "border-border",
  success: "border-success/40 text-success",
  warning: "border-warning/40 text-warning",
}

/** The mark every row leads with. Tone is carried twice — here and in the
    colour — because colour alone is no signal in forced-colours or to a reader
    who cannot tell the red from the green. */
const toneIcons: Record<NoticeTone, LucideIcon> = {
  danger: CircleAlert,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
}

/** Only what went wrong interrupts. A report of what worked is read out when
    the screen reader next comes up for air, which is what it is worth. */
const toneRoles: Record<NoticeTone, "alert" | "status"> = {
  danger: "alert",
  info: "status",
  success: "status",
  warning: "alert",
}

type NoticeCenterProps = {
  /** The tab in front, or null on the home tab, which owns no document. */
  activeDocumentId: number | null
  notices: Notice[]
  onAction: (notice: Notice) => void
  /** The reader's press on the X, which some notices answer for. */
  onDismiss: (notice: Notice) => void
  /** A transient notice reaching the end of its time, which none answer for. */
  onExpire: (id: string) => void
}

/**
 * The one corner of the window that speaks.
 *
 * Above the dialogs at `z-50`, because the corner has to be able to report on
 * work a modal started and then went on standing over. It shares the band and
 * the width of the find bar, which is the only other thing that floats here,
 * and steps below it in `index.css` while that bar is open.
 */
export function NoticeCenter({
  activeDocumentId,
  notices,
  onAction,
  onDismiss,
  onExpire,
}: NoticeCenterProps) {
  const shown = visibleNotices(notices, activeDocumentId)
  // Ids rather than the notices themselves, so the effect below settles: the
  // list is rebuilt on every raise, and only what it drops has to be answered.
  const overflow = overflowNotices(notices, activeDocumentId)
    .map((notice) => notice.id)
    .join(",")

  // A row the stack had no room for keeps no clock of its own, so it is let go
  // here rather than left to resurface once the rows above it expire.
  useEffect(() => {
    for (const id of overflow.split(",")) {
      if (id) {
        onExpire(id)
      }
    }
  }, [onExpire, overflow])

  return (
    // Base UI hides everything outside an open modal from a screen reader and
    // spares only live regions, which it finds by the attribute rather than by
    // the role each row carries. "off" leaves the announcing to those rows.
    <div
      aria-live="off"
      // The anchor moves in `index.css` while the find bar shares this band.
      className="pointer-events-none fixed top-25 right-4 z-70 flex w-88 flex-col gap-2 transition-[top] duration-150"
      data-slot="notice-center"
    >
      {shown.map((notice) => (
        <NoticeRow
          key={notice.id}
          notice={notice}
          onAction={onAction}
          onDismiss={onDismiss}
          onExpire={onExpire}
        />
      ))}
    </div>
  )
}

type NoticeRowProps = {
  notice: Notice
  onAction: (notice: Notice) => void
  onDismiss: (notice: Notice) => void
  onExpire: (id: string) => void
}

function NoticeRow({ notice, onAction, onDismiss, onExpire }: NoticeRowProps) {
  const { t } = useTranslation()
  const entry = noticeCatalogue[notice.kind]
  const clockKey = noticeClockKey(notice)
  const { id } = notice

  // Keyed on the lifetime rather than on the notice: a bar that moved is the
  // same notice, and a repeat is a new one even where the words are identical.
  useEffect(() => {
    if (entry.life === "standing") {
      return
    }

    const timer = window.setTimeout(() => onExpire(id), NOTICE_LIFE_MS)

    return () => window.clearTimeout(timer)
  }, [clockKey, entry.life, id, onExpire])

  // The catalogue is what pairs a message with the values that fill it, which
  // is past what the typed `t` can check; `notices.test.ts` walks the pairs.
  const message = t(entry.textKey, notice.values as TOptions)
  const action = notice.action ? noticeActions[notice.action.kind] : null
  const busy = notice.action?.busy === true
  const ToneIcon = toneIcons[entry.tone]

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-center gap-2 rounded-lg border bg-background px-4 py-2 text-sm shadow-lg",
        toneClasses[entry.tone],
      )}
      data-notice={notice.kind}
      // A notice that keeps changing while it stands would interrupt on every
      // step of a download, whatever its tone otherwise earns it.
      role={notice.progress === undefined ? toneRoles[entry.tone] : "status"}
    >
      {notice.progress === undefined ? (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <ToneIcon
            aria-hidden
            // A plain report is the one tone whose mark stays quiet: it says
            // what happened, and nothing about it needs answering.
            className={cn(
              "size-4 shrink-0",
              entry.tone === "info" && "text-muted-foreground",
            )}
          />
          <div className="min-w-0 flex-1">
            <p data-page-notice={isPageNotice(notice.kind) ? "" : undefined}>
              {message}
            </p>
            {"detailKey" in entry ? <p>{t(entry.detailKey)}</p> : null}
          </div>
          {action ? (
            <Button
              className="shrink-0"
              disabled={busy}
              onClick={() => onAction(notice)}
              size="sm"
              variant="outline"
            >
              {busy && "busyLabelKey" in action
                ? t(action.busyLabelKey)
                : t(action.labelKey)}
            </Button>
          ) : null}
        </div>
      ) : (
        <OperationProgress
          className="min-w-0 flex-1"
          label={message}
          progress={notice.progress}
        />
      )}
      <Button
        aria-label={t("notification.dismiss")}
        // The row's own colour, so a refusal keeps its red and a plain notice
        // does not borrow one.
        className="-my-1 -mr-2 text-current hover:bg-current/10 hover:text-current"
        onClick={() => onDismiss(notice)}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <X />
      </Button>
    </div>
  )
}
