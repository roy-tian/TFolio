import { useTranslation } from "react-i18next"

/** On a blank page a Save As will add, in the reading view or among the
    previews: saves without such pages, for every file of the document. */
export function PaddingDismiss({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation()

  return (
    <button
      // The paper is white in either theme, so the button keeps the light
      // theme's colours on it.
      className="max-w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-center text-xs leading-tight font-medium text-neutral-600 outline-none hover:border-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400 in-data-[pages-dragging]:hidden"
      data-page-control
      data-slot="padding-dismiss"
      onClick={onDismiss}
      type="button"
    >
      {t("sidebar.noPadding")}
    </button>
  )
}
