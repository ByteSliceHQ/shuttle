import { Check, ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

const GROUPS = ['frontier', 'fast'] as const

export function ModelSwitcher({
  value,
  onChange,
  disabled = false,
}: {
  value: OpenRouterModelId
  onChange: (model: OpenRouterModelId) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [previewId, setPreviewId] = useState<OpenRouterModelId>(value)

  const selected = getOpenRouterModel(value) ?? getOpenRouterModel(DEFAULT_OPENROUTER_MODEL)!

  const preview = useMemo(() => getOpenRouterModel(previewId) ?? selected, [previewId, selected])

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (next) {
          setPreviewId(value)
        }
      }}
    >
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="OpenRouter model"
        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground flex h-7 max-w-48 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-[3px] disabled:opacity-50"
      >
        <span className="truncate">{selected.label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="flex w-auto max-w-[min(100vw-2rem,36rem)] gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
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
                  onPreview={() => setPreviewId(model.id as OpenRouterModelId)}
                  onSelect={() => {
                    onChange(model.id as OpenRouterModelId)
                    setOpen(false)
                  }}
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
      </DropdownMenuContent>
    </DropdownMenu>
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
