import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  DEAL_MANUAL_CODE_PATTERN,
  HOLIDAY_PRESETS,
  MAX_BANNER_MESSAGE_LENGTH,
  MAX_DEALS_PER_CAMPAIGN,
  MAX_DEAL_NAME_LENGTH,
  MAX_DEAL_PERCENT,
  MIN_DEAL_PERCENT,
  createDealSchema,
  dealDays,
  dealWindowError,
  dealWindowForDays,
  defaultDealMessage,
  fillDealMessage,
  holidayDays,
  nextHolidayOccurrence,
  utcDay,
} from '@gopaylocal/shared'
import { api, type CreateDealInput, type Deal, type UpdateDealInput } from '~/lib/api'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'

// A campaign's holiday deals: GET/POST/PATCH/DELETE
// /v1/teams/:teamId/campaigns/:campaignId/deals. Listing needs campaigns.view,
// the controls need campaigns.update.
//
// The form works in whole UTC days (packages/shared/src/deals: dealWindowForDays),
// the days `{{ends}}` is written in, so the last day picked here is the day the
// banner says. The API itself takes any two instants.

const inputClass =
  'block w-full border border-border bg-bg px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:text-text-secondary'

/** Sentinel for "no holiday picked" (Radix can't use an empty value). */
const CUSTOM = 'custom'

/** Placeholders offered under the message field. The banner's other ones work too. */
const MESSAGE_PLACEHOLDERS = [
  { name: 'deal', help: "The deal's name" },
  { name: 'ends', help: 'The last day of the deal, such as 30 November' },
  { name: 'discount', help: "The deal's percentage" },
  { name: 'code', help: "The deal's code" },
] as const

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayYearFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const localFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** "27 Nov – 30 Nov 2026", or "25 Dec 2026" for one day. */
function dayRange(startsAt: string, endsAt: string): string {
  const { firstDay, lastDay } = dealDays(Date.parse(startsAt), Date.parse(endsAt))
  const last = dayYearFormat.format(new Date(`${lastDay}T00:00:00Z`))
  if (firstDay === lastDay) return last
  return `${dayFormat.format(new Date(`${firstDay}T00:00:00Z`))} – ${last}`
}

/** What the banner will say, with the percentage and the code filled in. */
function previewMessage(template: string, name: string, endsAtMs: number, percent: number | null, code: string | null) {
  return fillDealMessage(template, { name: name || 'Deal', endsAt: endsAtMs })
    .replaceAll('{{discount}}', percent === null ? '…' : String(percent))
    .replaceAll('{{code}}', code ?? '')
}

type Props = {
  teamId: string
  campaignId: string
  /** The campaign's payment platform ("Stripe"), or null when it has none. */
  providerLabel: string | null
  canEdit: boolean
  /** The campaign is an arm of a running A/B test. */
  inRunningTest: boolean
}

export function HolidayDeals({ teamId, campaignId, providerLabel, canEdit, inRunningTest }: Props) {
  const queryClient = useQueryClient()
  const queryKey = ['deals', teamId, campaignId]
  const { data: deals = [], isPending, error } = useQuery({
    queryKey,
    queryFn: () => api.deals.list(teamId, campaignId),
    enabled: !!teamId,
  })

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const remove = useMutation({
    mutationFn: (dealId: string) => api.deals.delete(teamId, campaignId, dealId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey })
      setDeletingId(null)
      if (result.warning) toast.warning('Deal deleted', { description: result.warning })
      else toast.success('Deal deleted')
    },
    onError: (err) => toast.error("Couldn't delete the deal", { description: err.message }),
  })

  // A deal whose code is missing gets it on any update: the API makes sure of
  // the code before it saves. Sending the name unchanged is that update.
  const createCode = useMutation({
    mutationFn: (deal: Deal) => api.deals.update(teamId, campaignId, deal.id, { name: deal.name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success('Code created')
    },
    onError: (err) => toast.error("Couldn't create the code", { description: err.message }),
  })

  const open = deals.filter((d) => d.phase !== 'ended')
  const ended = deals.filter((d) => d.phase === 'ended')
  const atLimit = open.length >= MAX_DEALS_PER_CAMPAIGN
  const hasProvider = providerLabel !== null

  return (
    <div className="border border-border">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-2.5">
        <span className="text-[13px] font-medium text-text-primary">Holiday deals</span>
        {!canEdit && <span className="text-[13px] text-text-secondary">View only</span>}
      </div>

      <div className="space-y-5 p-5">
        <div className="space-y-1.5 text-[13px] text-text-secondary">
          <p>
            A sale with a first and a last day: one percentage and one code for every visitor. While a deal runs, each
            visitor is offered the larger of the deal and their country's discount. Visitors from countries without a
            discount are offered the deal.
          </p>
          {inRunningTest && (
            <p className="text-amber-300">
              This campaign is in a running A/B test. A deal added here is offered only to the visitors who get this
              campaign.
            </p>
          )}
        </div>

        {isPending ? (
          <div className="flex h-16 items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-4 border-border border-t-brand" />
          </div>
        ) : error ? (
          <p className="text-[13px] text-brand-text">Couldn't load the deals: {error.message}</p>
        ) : (
          <>
            {deals.length === 0 && !showForm && (
              <p className="border border-dashed border-border px-4 py-6 text-center text-[13px] text-text-secondary">
                No deals yet.
              </p>
            )}

            {open.length > 0 && (
              <ul className="space-y-3">
                {open.map((deal) =>
                  editingId === deal.id ? (
                    <li key={deal.id}>
                      <EditDealForm
                        teamId={teamId}
                        campaignId={campaignId}
                        deal={deal}
                        onDone={() => setEditingId(null)}
                      />
                    </li>
                  ) : (
                    <DealRow
                      key={deal.id}
                      deal={deal}
                      canEdit={canEdit}
                      hasProvider={hasProvider}
                      confirming={deletingId === deal.id}
                      deleting={remove.isPending && deletingId === deal.id}
                      onEdit={() => {
                        setEditingId(deal.id)
                        setDeletingId(null)
                      }}
                      onAskDelete={() => setDeletingId(deal.id)}
                      onCancelDelete={() => setDeletingId(null)}
                      onDelete={() => remove.mutate(deal.id)}
                      onCreateCode={() => createCode.mutate(deal)}
                      creatingCode={createCode.isPending && createCode.variables?.id === deal.id}
                    />
                  ),
                )}
              </ul>
            )}

            {canEdit &&
              (showForm ? (
                <NewDealForm
                  teamId={teamId}
                  campaignId={campaignId}
                  providerLabel={providerLabel}
                  onDone={() => setShowForm(false)}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setShowForm(true)}
                    disabled={atLimit}
                    className="bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
                  >
                    New deal
                  </button>
                  {atLimit && (
                    <span className="text-[13px] text-text-secondary">
                      A campaign can have {MAX_DEALS_PER_CAMPAIGN} deals that have not ended. Delete one first.
                    </span>
                  )}
                </div>
              ))}

            {ended.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Ended</p>
                <ul className="mt-2 space-y-3">
                  {ended.map((deal) => (
                    <DealRow
                      key={deal.id}
                      deal={deal}
                      canEdit={canEdit}
                      hasProvider={hasProvider}
                      confirming={deletingId === deal.id}
                      deleting={remove.isPending && deletingId === deal.id}
                      onAskDelete={() => setDeletingId(deal.id)}
                      onCancelDelete={() => setDeletingId(null)}
                      onDelete={() => remove.mutate(deal.id)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const PHASE_LABEL = { live: 'Live', scheduled: 'Scheduled', ended: 'Ended' } as const
const PHASE_STYLE = {
  live: 'bg-success/15 text-success',
  scheduled: 'bg-surface text-text-primary',
  ended: 'bg-surface text-text-secondary',
} as const

function DealRow({
  deal,
  canEdit,
  hasProvider,
  confirming,
  deleting,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onCreateCode,
  creatingCode,
}: {
  deal: Deal
  canEdit: boolean
  hasProvider: boolean
  confirming: boolean
  deleting: boolean
  /** Absent for a deal that has ended: it can only be deleted. */
  onEdit?: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onDelete: () => void
  onCreateCode?: () => void
  creatingCode?: boolean
}) {
  const ended = deal.phase === 'ended'
  const copy = () => {
    if (!deal.code) return
    navigator.clipboard.writeText(deal.code)
    toast.success('Copied to clipboard')
  }

  return (
    <li className={`border border-border ${ended ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="truncate text-sm font-medium text-text-primary">{deal.name}</span>
            <span className={`px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${PHASE_STYLE[deal.phase]}`}>
              {PHASE_LABEL[deal.phase]}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-text-secondary" title={`${deal.startsAt} to ${deal.endsAt}`}>
            <span className="font-mono font-medium tabular-nums text-text-primary">{deal.discountPercent}%</span>
            <span aria-hidden="true"> · </span>
            <span className="tabular-nums">{dayRange(deal.startsAt, deal.endsAt)}</span> (UTC)
          </p>
        </div>

        {canEdit && !confirming && (
          <div className="flex shrink-0 items-center gap-4 text-[13px] font-medium">
            {onEdit && (
              <button type="button" onClick={onEdit} className="text-text-secondary transition-colors hover:text-text-primary">
                Edit
              </button>
            )}
            <button type="button" onClick={onAskDelete} className="text-red-400 transition-colors hover:text-red-300">
              Delete
            </button>
          </div>
        )}
      </div>

      {!ended && (
        <div className="border-t border-border px-4 py-3 text-[13px]">
          {deal.code ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-text-secondary">Code</span>
              <code className="font-mono text-sm text-text-primary">{deal.code}</code>
              <button type="button" onClick={copy} className="font-medium text-text-secondary transition-colors hover:text-text-primary">
                Copy
              </button>
            </div>
          ) : deal.codeSource === 'none' ? (
            <span className="text-text-secondary">No code: the banner shows the deal and its percentage.</span>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-amber-300">
                This deal has no working code, so it is not offered.
                {!hasProvider && ' Link a payment integration in Settings and its code is created there.'}
              </span>
              {hasProvider && canEdit && onCreateCode && (
                <button
                  type="button"
                  onClick={onCreateCode}
                  disabled={creatingCode}
                  className="border border-border px-3 py-1 font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50"
                >
                  {creatingCode ? 'Creating...' : 'Create code'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {confirming && (
        <div className="border-t border-red-800 bg-red-950/30 px-4 py-3">
          <p className="text-[13px] text-red-200">
            Delete "{deal.name}"?
            {deal.codeSource === 'provider' && !ended && ' Its code is removed from your payment platform and stops working.'}
          </p>
          <div className="mt-2.5 flex gap-3">
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Yes, delete'}
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={deleting}
              className="border border-border px-3 py-1.5 text-[13px] font-medium text-text-primary hover:bg-surface disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/** The message field with its placeholders and what the banner will say. */
function MessageField({
  id,
  value,
  onChange,
  preview,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  preview: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const insert = (name: string) => {
    const el = ref.current
    const token = `{{${name}}}`
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    onChange(value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text-primary">
        Banner message
      </label>
      <textarea
        id={id}
        ref={ref}
        rows={2}
        maxLength={MAX_BANNER_MESSAGE_LENGTH}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 ${inputClass}`}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {MESSAGE_PLACEHOLDERS.map(({ name, help }) => (
          <button
            key={name}
            type="button"
            title={help}
            onClick={() => insert(name)}
            className="border border-border px-2 py-0.5 font-mono text-[12px] text-text-primary transition-colors hover:bg-surface"
          >
            {`{{${name}}}`}
          </button>
        ))}
        <span className="text-[13px] text-text-secondary">and the banner's own placeholders.</span>
      </div>
      <p className="mt-2 border-l-2 border-border pl-3 text-[13px] text-text-primary">{preview}</p>
      <p className="mt-1.5 text-[13px] text-text-secondary">
        Shown in this campaign's banner, with its colors and button, while the deal is the visitor's offer.
      </p>
    </div>
  )
}

/** First and last day, with the same window in the browser's time zone. */
function DayFields({
  idPrefix,
  firstDay,
  lastDay,
  onFirstDay,
  onLastDay,
}: {
  idPrefix: string
  firstDay: string
  lastDay: string
  onFirstDay: (day: string) => void
  onLastDay: (day: string) => void
}) {
  const window = dealWindowForDays(firstDay, lastDay)
  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-first`} className="block text-sm font-medium text-text-primary">
            First day
          </label>
          <input
            id={`${idPrefix}-first`}
            type="date"
            value={firstDay}
            onChange={(e) => onFirstDay(e.target.value)}
            className={`mt-1 font-mono tabular-nums ${inputClass}`}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-last`} className="block text-sm font-medium text-text-primary">
            Last day
          </label>
          <input
            id={`${idPrefix}-last`}
            type="date"
            min={firstDay || undefined}
            value={lastDay}
            onChange={(e) => onLastDay(e.target.value)}
            className={`mt-1 font-mono tabular-nums ${inputClass}`}
          />
        </div>
      </div>
      <p className="mt-1.5 text-[13px] text-text-secondary">
        Days are in UTC: from 00:00 on the first day to 24:00 on the last.
        {window && (
          <>
            {' '}
            In your time zone that is{' '}
            <span className="tabular-nums text-text-primary">
              {localFormat.format(new Date(window.startsAt))} to {localFormat.format(new Date(window.endsAt))}
            </span>
            .
          </>
        )}
      </p>
    </div>
  )
}

function NewDealForm({
  teamId,
  campaignId,
  providerLabel,
  onDone,
}: {
  teamId: string
  campaignId: string
  providerLabel: string | null
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const hasProvider = providerLabel !== null

  const today = new Date()
  const todayDay = utcDay(today.getTime())
  // Each holiday with the next time it can still be run.
  const presets = HOLIDAY_PRESETS.flatMap((preset) => {
    const next = nextHolidayOccurrence(preset, {
      year: today.getUTCFullYear(),
      month: today.getUTCMonth() + 1,
      day: today.getUTCDate(),
    })
    return next ? [{ preset, next, ...holidayDays(next) }] : []
  }).sort((a, b) => (a.firstDay < b.firstDay ? -1 : a.firstDay > b.firstDay ? 1 : 0))

  const [presetId, setPresetId] = useState(CUSTOM)
  const [name, setName] = useState('')
  const [percent, setPercent] = useState('')
  const [firstDay, setFirstDay] = useState(todayDay)
  const [lastDay, setLastDay] = useState(todayDay)
  const [code, setCode] = useState('')
  // null: the default message for the kind of code, until the merchant types one.
  const [message, setMessage] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // A message about the form goes away as soon as a field is edited.
  const editing =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      setFormError(null)
      set(value)
    }

  const typedCode = code.trim()
  const codeSource = hasProvider ? 'provider' : typedCode ? 'manual' : 'none'
  const messageValue = message ?? defaultDealMessage(codeSource)
  const window = dealWindowForDays(firstDay, lastDay)
  const percentNumber = /^\d+$/.test(percent.trim()) ? Number(percent.trim()) : null

  const pickPreset = (id: string) => {
    setFormError(null)
    setPresetId(id)
    const picked = presets.find((p) => p.preset.id === id)
    if (!picked) return
    setName(picked.preset.name)
    // A holiday that has already begun starts today.
    setFirstDay(picked.firstDay < todayDay ? todayDay : picked.firstDay)
    setLastDay(picked.lastDay)
  }

  const create = useMutation({
    mutationFn: (data: CreateDealInput) => api.deals.create(teamId, campaignId, data),
    onSuccess: (deal) => {
      queryClient.invalidateQueries({ queryKey: ['deals', teamId, campaignId] })
      toast.success('Deal created', deal.code ? { description: `Code: ${deal.code}` } : undefined)
      onDone()
    },
    onError: (err) => setFormError(err.message),
  })

  const submit = () => {
    setFormError(null)
    if (!name.trim()) return setFormError('Give the deal a name.')
    if (percentNumber === null || percentNumber < MIN_DEAL_PERCENT || percentNumber > MAX_DEAL_PERCENT) {
      return setFormError(`The discount is a whole number from ${MIN_DEAL_PERCENT} to ${MAX_DEAL_PERCENT}.`)
    }
    if (!window) return setFormError('Pick a first day and a last day that is not before it.')
    if (Date.parse(window.endsAt) <= Date.now()) return setFormError('The last day is already over (days are in UTC).')
    if (typedCode && !DEAL_MANUAL_CODE_PATTERN.test(typedCode)) {
      return setFormError('A code is up to 40 letters, digits, dashes and underscores.')
    }
    const payload: CreateDealInput = {
      name: name.trim(),
      discountPercent: percentNumber,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      // Sent only when changed, so the API picks the default for the kind of code.
      ...(message !== null && message !== defaultDealMessage(codeSource) ? { messageTemplate: message } : {}),
      ...(!hasProvider && typedCode ? { code: typedCode } : {}),
    }
    const parsed = createDealSchema.safeParse(payload)
    if (!parsed.success) return setFormError(parsed.error.issues[0]?.message ?? 'Check the fields.')
    create.mutate(payload)
  }

  return (
    <div className="space-y-4 border border-border p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">New deal</p>

      <div>
        <label className="block text-sm font-medium text-text-primary">Holiday</label>
        <Select value={presetId} onValueChange={pickPreset}>
          <SelectTrigger className="mt-1 w-full" aria-label="Holiday">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={CUSTOM}>Your own dates</SelectItem>
              {presets.map(({ preset, firstDay: day }) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}, {dayYearFormat.format(new Date(`${day}T00:00:00Z`))}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-[13px] text-text-secondary">
          A holiday fills in the name and the days. Change them as you like.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
        <div>
          <label htmlFor="deal-name" className="block text-sm font-medium text-text-primary">
            Name
          </label>
          <input
            id="deal-name"
            type="text"
            maxLength={MAX_DEAL_NAME_LENGTH}
            value={name}
            onChange={(e) => editing(setName)(e.target.value)}
            placeholder="Black Friday"
            className={`mt-1 ${inputClass}`}
          />
        </div>
        <div>
          <label htmlFor="deal-percent" className="block text-sm font-medium text-text-primary">
            Discount (%)
          </label>
          <input
            id="deal-percent"
            type="number"
            inputMode="numeric"
            min={MIN_DEAL_PERCENT}
            max={MAX_DEAL_PERCENT}
            step={1}
            value={percent}
            onChange={(e) => editing(setPercent)(e.target.value)}
            placeholder="40"
            className={`mt-1 font-mono tabular-nums ${inputClass}`}
          />
        </div>
      </div>

      <DayFields
        idPrefix="deal"
        firstDay={firstDay}
        lastDay={lastDay}
        onFirstDay={editing(setFirstDay)}
        onLastDay={editing(setLastDay)}
      />

      {hasProvider ? (
        <p className="text-[13px] text-text-secondary">
          The code is created in {providerLabel} when you save, and removed there when the deal is over. The percentage
          cannot be changed afterwards.
        </p>
      ) : (
        <div>
          <label htmlFor="deal-code" className="block text-sm font-medium text-text-primary">
            Code <span className="font-normal text-text-secondary">(optional)</span>
          </label>
          <input
            id="deal-code"
            type="text"
            maxLength={40}
            value={code}
            onChange={(e) => editing(setCode)(e.target.value)}
            placeholder="BLACKFRIDAY40"
            className={`mt-1 font-mono ${inputClass}`}
          />
          <p className="mt-1.5 text-[13px] text-text-secondary">
            This campaign has no payment integration, so GoPayLocal cannot create the code. Enter one you made in your
            checkout, or leave this empty to show the deal without a code.
          </p>
        </div>
      )}

      <MessageField
        id="deal-message"
        value={messageValue}
        onChange={editing<string | null>(setMessage)}
        preview={previewMessage(
          messageValue,
          name.trim(),
          window ? Date.parse(window.endsAt) : Date.now(),
          percentNumber,
          hasProvider ? '(your code)' : typedCode || null,
        )}
      />

      {formError && <p className="text-[13px] text-brand-text">{formError}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={create.isPending}
          className="bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
        >
          {create.isPending ? 'Creating...' : 'Create deal'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={create.isPending}
          className="border border-border px-4 py-2 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function EditDealForm({
  teamId,
  campaignId,
  deal,
  onDone,
}: {
  teamId: string
  campaignId: string
  deal: Deal
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const original = dealDays(Date.parse(deal.startsAt), Date.parse(deal.endsAt))
  const [name, setName] = useState(deal.name)
  const [firstDay, setFirstDay] = useState(original.firstDay)
  const [lastDay, setLastDay] = useState(original.lastDay)
  const [message, setMessage] = useState(deal.messageTemplate)
  const [formError, setFormError] = useState<string | null>(null)

  const editing =
    (set: (value: string) => void) =>
    (value: string) => {
      setFormError(null)
      set(value)
    }

  const window = dealWindowForDays(firstDay, lastDay)
  // Only what changed is sent: a deal made through the API with exact times
  // keeps them unless its days are changed here.
  const changes: UpdateDealInput = {
    ...(name.trim() !== deal.name ? { name: name.trim() } : {}),
    ...(window && firstDay !== original.firstDay ? { startsAt: window.startsAt } : {}),
    ...(window && lastDay !== original.lastDay ? { endsAt: window.endsAt } : {}),
    ...(message !== deal.messageTemplate ? { messageTemplate: message } : {}),
  }
  const dirty = Object.keys(changes).length > 0
  const endsAtMs = Date.parse(changes.endsAt ?? deal.endsAt)

  const save = useMutation({
    mutationFn: (data: UpdateDealInput) => api.deals.update(teamId, campaignId, deal.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deals', teamId, campaignId] })
      toast.success('Deal updated')
      onDone()
    },
    onError: (err) => setFormError(err.message),
  })

  const submit = () => {
    setFormError(null)
    if (!name.trim()) return setFormError('Give the deal a name.')
    if (!window) return setFormError('Pick a first day and a last day that is not before it.')
    if (!message.trim()) return setFormError('The message cannot be empty.')
    const windowError = dealWindowError(changes.startsAt ?? deal.startsAt, changes.endsAt ?? deal.endsAt)
    if (windowError) return setFormError(`${windowError}.`)
    save.mutate(changes)
  }

  return (
    <div className="space-y-4 border border-brand p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">Edit deal</p>
        <p className="text-[13px] text-text-secondary">
          <span className="font-mono font-medium tabular-nums text-text-primary">{deal.discountPercent}%</span>
          {deal.code && (
            <>
              <span aria-hidden="true"> · </span>
              <code className="font-mono text-text-primary">{deal.code}</code>
            </>
          )}
        </p>
      </div>

      <div>
        <label htmlFor={`deal-name-${deal.id}`} className="block text-sm font-medium text-text-primary">
          Name
        </label>
        <input
          id={`deal-name-${deal.id}`}
          type="text"
          maxLength={MAX_DEAL_NAME_LENGTH}
          value={name}
          onChange={(e) => editing(setName)(e.target.value)}
          className={`mt-1 ${inputClass}`}
        />
      </div>

      <DayFields
        idPrefix={`deal-${deal.id}`}
        firstDay={firstDay}
        lastDay={lastDay}
        onFirstDay={editing(setFirstDay)}
        onLastDay={editing(setLastDay)}
      />

      <MessageField
        id={`deal-message-${deal.id}`}
        value={message}
        onChange={editing(setMessage)}
        preview={previewMessage(message, name.trim(), endsAtMs, deal.discountPercent, deal.code)}
      />

      <p className="text-[13px] text-text-secondary">
        The percentage and the code stay as they are. For another percentage, delete this deal and create a new one.
      </p>

      {formError && <p className="text-[13px] text-brand-text">{formError}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!dirty || save.isPending}
          className="bg-brand px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
        >
          {save.isPending ? 'Saving...' : 'Save deal'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={save.isPending}
          className="border border-border px-4 py-2 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
