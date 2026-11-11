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

type ReloadPromptProps = {
  name: string
  onAnswer: (reload: boolean) => void
  open: boolean
}

/** Asked when a file opened again was changed elsewhere while its tab holds
    unsaved work: keep that work, or take the file as it now stands. */
export function ReloadPrompt({ name, onAnswer, open }: ReloadPromptProps) {
  const { t } = useTranslation()

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onAnswer(false)
        }
      }}
      open={open}
    >
      <AlertDialogContent data-slot="reload-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("tabs.reloadTitle", { name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("tabs.reloadDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-action="reload-keep">
            {t("tabs.reloadKeep")}
          </AlertDialogCancel>
          <AlertDialogAction
            data-action="reload-confirm"
            onClick={() => onAnswer(true)}
            variant="destructive"
          >
            {t("tabs.reloadConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
