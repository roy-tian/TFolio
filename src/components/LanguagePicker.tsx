import { useRef, useState, type KeyboardEvent } from "react"
import { ChevronDown, Monitor } from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { changeLanguagePreference, useLanguagePreference } from "@/i18n"
import {
  detectSystemLanguage,
  languageCodes,
  languageGroups,
  languageNames,
  systemLanguage,
  type LanguagePreference,
  type SupportedLanguage,
} from "@/i18n/config"
import { translations } from "@/i18n/resources"
import { stepInRows } from "@/lib/rowNavigation"
import { cn } from "@/lib/utils"

const COLUMNS = 3

function inRows(group: ReadonlyArray<SupportedLanguage>) {
  return Array.from({ length: Math.ceil(group.length / COLUMNS) }, (_, row) =>
    group.slice(row * COLUMNS, (row + 1) * COLUMNS),
  )
}

const groupRows = languageGroups.map(inRows)
const rows: LanguagePreference[][] = [[systemLanguage], ...groupRows.flat()]

function LanguageBadge({
  chosen = false,
  value,
}: {
  chosen?: boolean
  value: LanguagePreference
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4.5 w-6.5 shrink-0 items-center justify-center rounded-[5px] border text-[10px] leading-none font-semibold tracking-wide",
        chosen
          ? "border-primary bg-primary text-primary-foreground"
          : "border-foreground/15 bg-muted/60 text-muted-foreground",
      )}
    >
      {value === systemLanguage ? (
        <Monitor className="size-3" />
      ) : (
        languageCodes[value]
      )}
    </span>
  )
}

type LanguagePickerProps = {
  id: string
}

/** The interface language, chosen from rows of three: every language shows at
    once, each under its own name. */
export function LanguagePicker({ id }: LanguagePickerProps) {
  const { t } = useTranslation()
  const preference = useLanguagePreference()
  const [open, setOpen] = useState(false)
  const chosenRef = useRef<HTMLButtonElement>(null)

  // In the language it switches to, like the names beside it, so a reader
  // stranded in an interface they cannot read still recognises it.
  const systemLabelLanguage = detectSystemLanguage()
  const systemLabel = translations[systemLabelLanguage].settings.languageSystem
  const nameOf = (value: LanguagePreference) =>
    value === systemLanguage ? systemLabel : languageNames[value]
  const languageOf = (value: LanguagePreference) =>
    value === systemLanguage ? systemLabelLanguage : value

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-language]",
    )?.dataset.language
    const next =
      current && stepInRows(rows, current as LanguagePreference, event.key)

    if (next) {
      event.preventDefault()
      event.currentTarget
        .querySelector<HTMLElement>(`[data-language="${next}"]`)
        ?.focus()
    }
  }

  const option = (value: LanguagePreference) => {
    const chosen = value === preference

    return (
      <button
        aria-selected={chosen}
        className={cn(
          "flex items-center gap-2 rounded-md py-1.5 pr-3 pl-1.5 text-left text-sm whitespace-nowrap outline-none select-none focus:bg-accent focus:text-accent-foreground",
          chosen && "font-medium",
          value === systemLanguage && "col-span-full",
        )}
        data-language={value}
        key={value}
        onClick={() => {
          setOpen(false)
          void changeLanguagePreference(value)
        }}
        // One highlight, as in a menu: the pointer takes it from the keys.
        onPointerMove={(event) =>
          event.currentTarget.focus({ preventScroll: true })
        }
        ref={chosen ? chosenRef : undefined}
        role="option"
        tabIndex={chosen ? 0 : -1}
        type="button"
      >
        <LanguageBadge chosen={chosen} value={value} />
        <span lang={languageOf(value)}>{nameOf(value)}</span>
      </button>
    )
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        className="flex h-8 w-full max-w-72 items-center gap-2 rounded-lg border border-input bg-transparent pr-2 pl-1.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
        id={id}
      >
        <LanguageBadge value={preference} />
        <span
          className="min-w-0 flex-1 truncate text-left"
          lang={languageOf(preference)}
        >
          {nameOf(preference)}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-(--anchor-width) gap-0 p-1"
        initialFocus={chosenRef}
      >
        <div
          aria-label={t("settings.language")}
          className="grid grid-cols-3 gap-x-1"
          data-slot="language-options"
          onKeyDown={handleKeyDown}
          role="listbox"
        >
          {option(systemLanguage)}
          {groupRows.map((group) => [
            <div
              className="col-span-full -mx-1 my-1 h-px bg-border"
              key={`before-${group[0][0]}`}
              role="presentation"
            />,
            group.flat().map(option),
          ])}
        </div>
      </PopoverContent>
    </Popover>
  )
}
