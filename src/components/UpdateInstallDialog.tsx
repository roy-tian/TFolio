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

type UpdateInstallDialogProps = {
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
  open: boolean
}

/**
 * What the reader is asked before an install takes the app away.
 *
 * Not a notice: the corner reports, and this one step needs an answer before
 * anything happens — a restart discards unsaved work in every window, not only
 * the one the offer was pressed in.
 */
export function UpdateInstallDialog({
  onConfirm,
  onOpenChange,
  open,
}: UpdateInstallDialogProps) {
  const { t } = useTranslation()

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      {/* The wider of the two sizes: the paragraph has to say both what the
          restart costs and that leaving is free, and neither answer is short. */}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("update.installTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("update.installDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Stacked, and the way out first: neither label shares a row, and
            the one that discards work should not be the easy one to hit. */}
        <AlertDialogFooter className="flex-col sm:flex-col">
          <AlertDialogCancel>{t("update.installCancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} variant="destructive">
            {t("update.installDiscard")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
