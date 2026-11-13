import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  fetchVendorModels,
  type HarnessId,
  type Team,
  type VendorHarnessId,
  type VendorModel,
  type VendorModelChoice,
  type VendorModelChoices,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  DEFAULT_OPENROUTER_MODEL,
  formatContextWindow,
  getOpenRouterModel,
  MODEL_GROUP_LABELS,
  MODEL_TAG_LABELS,
  MODEL_TAG_TONES,
  modelsByGroup,
  type OpenRouterModel,
  type OpenRouterModelId,
} from '@/lib/llm-models'
import {
  chosenVendorModel,
  effortLabel,
  modelSections,
  SECTION_LABELS,
  vendorChoiceLabel,
  withVendorModel,
  type ModelSection,
} from '@/lib/vendor-models'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

const GROUPS = ['frontier', 'fast'] as const

/** What each section's models are used for, shown under its name in the rail. */
const SECTION_HINTS: Record<ModelSection, string> = {
  openrouter: 'Conductor and workers',
  codex: 'Your subscription',
  'claude-code': 'Your subscription',
}

/** Model lists already fetched, so the trigger can name a model without waiting on each mount. */
const vendorModelCache = new Map<VendorHarnessId, readonly VendorModel[]>()

function useVendorModels(harnesses: readonly VendorHarnessId[], refresh: boolean) {
  const [models, setModels] = useState<ReadonlyMap<VendorHarnessId, readonly VendorModel[]>>(
    () => new Map(vendorModelCache),
  )

  const wanted = harnesses.join(',')

  useEffect(() => {
    let cancelled = false

    for (const harness of wanted.split(',').filter(Boolean) as VendorHarnessId[]) {
      if (vendorModelCache.has(harness) && !refresh) {
        continue
      }

      fetchVendorModels(harness).then(
        (result) => {
          vendorModelCache.set(harness, result.models)

          if (!cancelled) {
            setModels(new Map(vendorModelCache))
          }
        },
        // The picker still offers the agent's default without a list.
        () => {},
      )
    }

    return () => {
      cancelled = true
    }
  }, [wanted, refresh])

  return models
}

/**
 * Picks the model for whoever does the work in a session. A session run by Codex or Claude Code
 * offers that agent's models; a Shuttle session offers OpenRouter's for the conductor and
 * workers, plus a section for each vendor agent on its team.
 */
export function ModelSwitcher({
  harness,
  team,
  value,
  onChange,
  vendorChoices,
  onVendorChoiceChange,
  disabled = false,
}: {
  harness: HarnessId
  team: Team
  value: OpenRouterModelId
  onChange: (model: OpenRouterModelId) => void
  vendorChoices: VendorModelChoices
  onVendorChoiceChange: (harness: VendorHarnessId, choice: VendorModelChoice) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<ModelSection | null>(null)

  const sections = modelSections(harness, team)
  const primary = sections[0] ?? 'openrouter'
  const section = picked && sections.includes(picked) ? picked : primary

  const vendorSections = sections.filter(
    (entry): entry is VendorHarnessId => entry !== 'openrouter',
  )

  const vendorModels = useVendorModels(vendorSections, open)
  const selected = getOpenRouterModel(value) ?? getOpenRouterModel(DEFAULT_OPENROUTER_MODEL)!

  const summary = (entry: ModelSection): string =>
    entry === 'openrouter'
      ? selected.label
      : vendorChoiceLabel(vendorChoices[entry], vendorModels.get(entry) ?? [])

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (next) {
          setPicked(null)
        }
      }}
    >
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`${SECTION_LABELS[primary]} model`}
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground ease-snappy flex h-7 max-w-40 min-w-0 shrink items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap transition-[background-color,color,transform] duration-150 outline-none focus-visible:ring-[3px] active:scale-[0.97] disabled:opacity-50 sm:max-w-56"
      >
        <span className="truncate">{summary(primary)}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={12}
        side="top"
        sideOffset={8}
        className="flex w-auto max-w-[min(100vw-2rem,46rem)] gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {sections.length > 1 ? (
          <div
            role="tablist"
            aria-label="Models for"
            aria-orientation="vertical"
            className="border-border flex w-36 shrink-0 flex-col gap-0.5 border-r p-1"
          >
            {sections.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={entry === section}
                onClick={() => setPicked(entry)}
                className={cn(
                  'flex w-full cursor-default flex-col rounded-sm px-2 py-1.5 text-left outline-none select-none',
                  entry === section
                    ? 'bg-accent text-accent-foreground'
                    : 'text-popover-foreground hover:bg-accent/50',
                )}
              >
                <span className="text-xs font-medium">{SECTION_LABELS[entry]}</span>
                <span className="text-muted-foreground truncate text-[10px]">
                  {SECTION_HINTS[entry]}
                </span>
                <span className="text-muted-foreground/80 mt-0.5 truncate text-[10px]">
                  {summary(entry)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {section === 'openrouter' ? (
          <OpenRouterPane
            value={value}
            selected={selected}
            onSelect={(model) => {
              onChange(model)
              setOpen(false)
            }}
          />
        ) : (
          <VendorPane
            harness={section}
            models={vendorModels.get(section)}
            choice={vendorChoices[section]}
            onChange={(choice) => onVendorChoiceChange(section, choice)}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OpenRouterPane({
  value,
  selected,
  onSelect,
}: {
  value: OpenRouterModelId
  selected: OpenRouterModel
  onSelect: (model: OpenRouterModelId) => void
}) {
  const [previewId, setPreviewId] = useState<string>(value)
  const preview = useMemo(() => getOpenRouterModel(previewId) ?? selected, [previewId, selected])

  return (
    <>
      <div className="flex max-h-80 w-56 shrink-0 flex-col overflow-y-auto overscroll-contain p-1 sm:w-60">
        {GROUPS.map((group, index) => (
          <div key={group}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{MODEL_GROUP_LABELS[group]}</DropdownMenuLabel>
            {modelsByGroup(group).map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                selected={model.id === value}
                previewed={model.id === preview.id}
                onPreview={() => setPreviewId(model.id)}
                onSelect={() => onSelect(model.id as OpenRouterModelId)}
              />
            ))}
          </div>
        ))}
      </div>
      <aside className="border-border hidden w-52 shrink-0 border-l p-3 sm:block">
        <p className="text-foreground text-xs font-medium">{preview.label}</p>
        <p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
          {preview.description}
        </p>
        <p className="text-muted-foreground/80 mt-2 text-[11px]">
          {formatContextWindow(preview.context)}
        </p>
        {preview.note ? (
          <p className="text-muted-foreground/70 mt-1 text-[11px] italic">{preview.note}</p>
        ) : null}
        <div className="mt-2.5 flex flex-wrap gap-1">
          {preview.tags.map((tag) => (
            <span
              key={tag}
              className={cn(
                'inline-flex h-5 items-center rounded-md px-1.5 text-[10px] font-medium',
                MODEL_TAG_TONES[tag],
              )}
            >
              {MODEL_TAG_LABELS[tag]}
            </span>
          ))}
        </div>
      </aside>
    </>
  )
}

/** A vendor agent's models on the left, and the reasoning effort for the chosen one beside it. */
function VendorPane({
  harness,
  models,
  choice,
  onChange,
}: {
  harness: VendorHarnessId
  /** Undefined while the agent's list is still being fetched. */
  models: readonly VendorModel[] | undefined
  choice: VendorModelChoice | undefined
  onChange: (choice: VendorModelChoice) => void
}) {
  const list = models ?? []
  const defaultModel = list.find((model) => model.isDefault)
  const current = chosenVendorModel(choice, list)
  const efforts = current?.efforts ?? []
  const agent = SECTION_LABELS[harness]

  return (
    <>
      <div className="flex max-h-80 w-56 shrink-0 flex-col overflow-y-auto overscroll-contain p-1 sm:w-60">
        <DropdownMenuLabel>{agent} models</DropdownMenuLabel>
        <CheckRow
          label="Default"
          hint={defaultModel?.label}
          selected={!choice?.model}
          onSelect={() => onChange(withVendorModel(choice, undefined, defaultModel))}
        />
        {list.map((model) => (
          <CheckRow
            key={model.id}
            label={model.label}
            selected={choice?.model === model.id}
            onSelect={() => onChange(withVendorModel(choice, model, defaultModel))}
          />
        ))}
        {/* A model picked earlier that the agent no longer lists still shows as the choice. */}
        {choice?.model && !current ? <CheckRow label={choice.model} selected /> : null}
        {models ? null : (
          <p className="text-muted-foreground px-2 py-1.5 text-[11px]">Loading models…</p>
        )}
      </div>
      <aside className="border-border flex max-h-80 w-52 shrink-0 flex-col overflow-y-auto border-l p-1">
        <div className="px-2 pt-2 pb-1.5">
          <p className="text-foreground text-xs font-medium">
            {current?.label ?? choice?.model ?? `${agent} default`}
          </p>
          <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
            {choice?.model ? current?.description : `Whichever model ${agent} picks for your plan.`}
          </p>
        </div>
        {efforts.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
            <CheckRow
              label="Default"
              hint={current?.defaultEffort ? effortLabel(current.defaultEffort) : undefined}
              selected={!choice?.effort}
              onSelect={() => onChange(choice?.model ? { model: choice.model } : {})}
            />
            {efforts.map((effort) => (
              <CheckRow
                key={effort}
                label={effortLabel(effort)}
                selected={choice?.effort === effort}
                onSelect={() =>
                  onChange({ ...(choice?.model ? { model: choice.model } : {}), effort })
                }
              />
            ))}
          </>
        ) : null}
      </aside>
    </>
  )
}

function CheckRow({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string
  hint?: string | undefined
  selected: boolean
  onSelect?: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className="text-popover-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-7 text-left text-xs outline-none select-none"
    >
      <span className="absolute top-2 left-2 flex size-3.5 items-center justify-center">
        {selected ? <Check className="size-3.5" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="text-muted-foreground shrink-0 text-[10px]">{hint}</span> : null}
    </button>
  )
}

function ModelRow({
  model,
  selected,
  previewed,
  onPreview,
  onSelect,
}: {
  model: OpenRouterModel
  selected: boolean
  previewed: boolean
  onPreview: () => void
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onMouseEnter={onPreview}
      onFocus={onPreview}
      onClick={onSelect}
      className={cn(
        'relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-7 text-left text-xs outline-none select-none',
        previewed ? 'bg-accent text-accent-foreground' : 'text-popover-foreground',
      )}
    >
      <span className="absolute top-2 left-2 flex size-3.5 items-center justify-center">
        {selected ? <Check className="size-3.5" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{model.label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {model.tags.map((tag) => (
          <span
            key={tag}
            className={cn(
              'inline-flex h-4 items-center rounded px-1 text-[10px] font-medium',
              MODEL_TAG_TONES[tag],
            )}
          >
            {MODEL_TAG_LABELS[tag]}
          </span>
        ))}
      </span>
    </button>
  )
}
