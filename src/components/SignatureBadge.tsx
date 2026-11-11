import { FileSignature } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { cn } from "@/lib/utils"

/** A file's digital signatures, by their structure on disk: intact, or
    `broken` where they no longer hold. Never a claim about who signed. */
export function SignatureBadge({
  broken = false,
  className,
  count,
  inDelayGroup = false,
  onClick,
}: {
  broken?: boolean
  className?: string
  count: number
  inDelayGroup?: boolean
  /** Where the badge stands in for its row's own click target. */
  onClick?: () => void
}) {
  const { t } = useTranslation()
  const label = t(broken ? "signatures.brokenCount" : "signatures.count", { count })

  return (
    <HintTooltip inDelayGroup={inDelayGroup} label={label}>
      <span
        aria-label={label}
        className={cn(
          "grid shrink-0 place-items-center",
          broken ? "text-warning" : "text-muted-foreground",
          className,
        )}
        data-signatures={count}
        data-signatures-broken={broken ? "" : undefined}
        onClick={onClick}
        role="img"
      >
        <FileSignature className="size-3.5" />
      </span>
    </HintTooltip>
  )
}

/** Beside the caption of a page thumbnail showing a signature field's
    widget; few pages have one, so each may carry its own hint. */
export function PageSignatureMark() {
  const { t } = useTranslation()
  const label = t("signatures.page")

  return (
    <HintTooltip label={label}>
      <span
        aria-label={label}
        className="grid size-4 shrink-0 place-items-center text-muted-foreground"
        data-page-signature
        role="img"
      >
        <FileSignature className="size-3.5" />
      </span>
    </HintTooltip>
  )
}
