import { useId } from "react"
import { useTranslation } from "react-i18next"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { SignaturePromptRequest } from "@/hooks/useSignaturePrompt"
import type { SignatureDecision } from "@/lib/pdf"

type SignaturePromptProps = {
  onAnswer: (answer: SignatureDecision | null) => void
  onRememberChange: (remember: boolean) => void
  open: boolean
  remember: boolean
  request: SignaturePromptRequest | null
}

/** Asked before the first change that would break intact signatures: whether
    to flatten them into the pages, keeping their look, or keep the fields,
    which then read as invalid. Either way the signed file stays as it is. */
export function SignaturePrompt({
  onAnswer,
  onRememberChange,
  open,
  remember,
  request,
}: SignaturePromptProps) {
  const { t } = useTranslation()
  const rememberId = useId()
  const values = { count: request?.count ?? 1, name: request?.name ?? "" }

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onAnswer(null)
        }
      }}
      open={open}
    >
      <AlertDialogContent data-slot="signature-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("signatures.promptTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {request?.context === "insert"
              ? t("signatures.promptInsert", values)
              : request?.context === "export"
                ? t("signatures.promptExport", values)
                : t("signatures.promptEdit", values)}{" "}
            {t("signatures.promptOriginal")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          <li>{t("signatures.flattenHint")}</li>
          <li>{t("signatures.keepHint")}</li>
        </ul>
        <div className="flex items-center gap-2">
          <Checkbox
            checked={remember}
            data-slot="signature-prompt-remember"
            id={rememberId}
            onCheckedChange={onRememberChange}
          />
          <Label className="font-normal" htmlFor={rememberId}>
            {t("signatures.remember")}
          </Label>
        </div>
        {/* Stacked: three choices this long fit no row in every language. */}
        <AlertDialogFooter className="sm:flex-col-reverse">
          <AlertDialogCancel>{t("signatures.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            data-action="signatures-keep"
            onClick={() => onAnswer("keep")}
            variant="outline"
          >
            {t("signatures.keep")}
          </AlertDialogAction>
          <AlertDialogAction
            data-action="signatures-flatten"
            onClick={() => onAnswer("flatten")}
          >
            {t("signatures.flatten")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
