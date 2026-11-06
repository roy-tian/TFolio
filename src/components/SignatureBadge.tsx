import { FileSignature } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { cn } from "@/lib/utils"

/** A file whose digital signatures are intact, by their structure on disk:
    never a claim about who signed or whether to trust them. */
export function SignatureBadge({
  className,
  count,
  inDelayGroup = false,
  onClick,
}: {
  className?: string
  count: number
  inDelayGroup?: boolean
  /** Where the badge stands in for its row's own click target. */
  onClick?: () => void
}) {
  const { t } = useTranslation()
  const label = t("signatures.count", { count })

  return (
    <HintTooltip inDelayGroup={inDelayGroup} label={label}>
      <span
        aria-label={label}
        className={cn("grid shrink-0 place-items-center text-muted-foreground", className)}
        data-signatures={count}
        onClick={onClick}
        role="img"
      >
        <FileSignature className="size-3.5" />
      </span>
    </HintTooltip>
  )
}
