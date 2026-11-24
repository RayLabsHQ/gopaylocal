import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  COUNTRY_NAMES,
  countryDiscount,
  MAX_BANNER_COLOR_LENGTH,
  MAX_BANNER_CTA_LENGTH,
  MAX_BANNER_MESSAGE_LENGTH,
  updateBannerConfigSchema,
  workspaceParityGroupsFromList,
  type BannerConfig,
  type BannerPosition,
} from '@gopaylocal/shared'
import { currencyForCountry, localPricing, type LocalPricing } from '@gopaylocal/shared/currency'
import { api, ApiError, type FxRatesView } from '~/lib/api'
import { usePermissions } from '~/lib/permissions'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
// The preview is drawn by the banner's own renderer (the script tag calls the
// same function), so it cannot drift from what visitors see. Relative imports,
// like the API's import of the banner bundle: packages/banner is not a
// published package.
import { PLACEHOLDERS, render, type BannerData } from '../../../../packages/banner/src/render'
import { cssColor, formatMoney, type TemplateData } from '../../../../packages/js-sdk/src/core'
import { ErrorText } from '~/components/ui/status'
import { btnPrimary, btnSecondary } from '~/components/ui/page'

// Edits a campaign's banner design: GET/PUT /v1/teams/:teamId/banner-configs/:campaignId.
// Loading needs banners.view; the controls need banners.update. A role without
// banners.update sees the values and the preview, read-only, with no Save
// button. A save rebuilds the banner cache on the API side, so visitors get the
// new design without anything else to do.

type Field = keyof BannerConfig
type ColorField = 'backgroundColor' | 'textColor' | 'ctaColor' | 'ctaTextColor'
type Placeholder = (typeof PLACEHOLDERS)[number]
type FieldErrors = Partial<Record<Field, string>>

const FIELDS = [
  'position',
  'messageTemplate',
  'ctaText',
  'backgroundColor',
  'textColor',
  'ctaColor',
  'ctaTextColor',
  'showFlag',
  'showCloseBtn',
] as const satisfies readonly Field[]

const POSITIONS: { value: BannerPosition; label: string }[] = [
  { value: 'top', label: 'Bar at the top' },
  { value: 'bottom', label: 'Bar at the bottom' },
  { value: 'bottom-left', label: 'Card, bottom left' },
  { value: 'bottom-right', label: 'Card, bottom right' },
]

const COLORS: { field: ColorField; label: string }[] = [
  { field: 'backgroundColor', label: 'Background' },
  { field: 'textColor', label: 'Text' },
  { field: 'ctaColor', label: 'Button' },
  { field: 'ctaTextColor', label: 'Button text' },
]

const PLACEHOLDER_HELP: Record<Placeholder, string> = {
  countryName: "The visitor's country, e.g. India",
  country: 'Two-letter country code, e.g. IN',
  flag: "The country's flag emoji",
  discount: 'Discount percentage, e.g. 40 (shown in bold)',
  code: 'Coupon code, e.g. PPP-IN40-K7QX (shown in bold); empty when there is no code',
  localPrice:
    "Your product's price after the discount, in the visitor's currency (an estimate, rounded up) or exactly in yours, e.g. ₹719",
  localOriginalPrice: "Your product's price before the discount, the same way, e.g. ₹1,769",
  currencySymbol: 'Symbol of the currency those prices are in, e.g. ₹',
  currencyCode: 'Code of that currency, e.g. INR',
}

/**
 * A sample coupon code in the real format, {PREFIX}-{COUNTRY}{DISCOUNT}-{RANDOM}
 * (apps/api/src/lib/coupon-code.ts); Stripe, Paddle, Polar and Creem codes drop the dashes.
 */
function sampleCouponCode(country: string, discount: number): string {
  return `PPP-${country}${Math.round(discount)}-K7QX`
}

// The visitor the preview shows until the campaign, product and rates load.
const FALLBACK_SAMPLE: TemplateData = { country: 'IN', countryName: 'India', discount: 40, code: sampleCouponCode('IN', 40) }

/** A visitor the preview can show: a country this campaign gives a discount. */
type SampleCountry = { code: string; name: string; discount: number }

/** The stored rates document, passed to localPricing() as the banner endpoint does; null when none is usable. */
function fxDocOf(view: FxRatesView | undefined) {
  return view?.available ? view.fx : null
}

/** Currencies this deployment never converts to (FX_EXCLUDED_CURRENCIES), as the banner endpoint applies them. */
function excludedOf(view: FxRatesView | undefined): ReadonlySet<string> {
  return new Set(view?.available ? (view.excludedCurrencies ?? []) : [])
}

// WCAG AA for normal-size text; the banner's text is 13-14px.
const MIN_CONTRAST = 4.5

function pick(config: BannerConfig): BannerConfig {
  return Object.fromEntries(FIELDS.map((f) => [f, config[f]])) as BannerConfig
}

function changedFields(saved: BannerConfig, draft: BannerConfig): Partial<BannerConfig> {
  return Object.fromEntries(FIELDS.filter((f) => draft[f] !== saved[f]).map((f) => [f, draft[f]]))
}

// The length limits are updateBannerConfigSchema's; the inputs also cap them (maxLength).
function messageFor(field: Field, code: string, fallback: string): string {
  if (code === 'too_big') {
    if (field === 'messageTemplate') return `Keep the message to ${MAX_BANNER_MESSAGE_LENGTH} characters or fewer.`
    if (field === 'ctaText') return `Keep the button text to ${MAX_BANNER_CTA_LENGTH} characters or fewer.`
    if (field.endsWith('Color')) return `Enter a color of ${MAX_BANNER_COLOR_LENGTH} characters or fewer.`
  }
  if (field === 'messageTemplate') return 'Enter a message.'
  if (field === 'ctaText') return 'Enter the button text.'
  if (field === 'position') return 'Pick a position.'
  if (field.endsWith('Color')) return 'Enter a color.'
  return fallback
}

function isField(key: unknown): key is Field {
  return typeof key === 'string' && (FIELDS as readonly string[]).includes(key)
}

/** Field errors from a 400 { error: 'Validation failed', details: { fieldErrors } }. */
function serverFieldErrors(err: Error): FieldErrors {
  if (!(err instanceof ApiError) || err.status !== 400) return {}
  const fieldErrors = (err.data?.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {}
  const out: FieldErrors = {}
  for (const [key, messages] of Object.entries(fieldErrors)) {
    if (isField(key) && messages[0]) out[key] = messages[0]
  }
  return out
}

// ── Color checks ───────────────────────────────────────────────────────────

type Rgba = { r: number; g: number; b: number; a: number }
let canvasContext: CanvasRenderingContext2D | null | undefined

/**
 * How a browser reads `value` once the banner has cleaned it with cssColor():
 * an RGBA color, 'invalid' when the browser rejects it (the banner then drops
 * the declaration), or null when this check cannot tell (no canvas, or a
 * color space the canvas reports in a format not parsed here).
 */
function readColor(value: string): Rgba | 'invalid' | null {
  const cleaned = cssColor(value).trim()
  if (!cleaned) return 'invalid'
  if (canvasContext === undefined) canvasContext = document.createElement('canvas').getContext('2d')
  const ctx = canvasContext
  if (!ctx) return null
  // An invalid assignment is ignored, so two different starting values that
  // both survive mean the browser rejected the color.
  ctx.fillStyle = '#000000'
  ctx.fillStyle = cleaned
  const first = String(ctx.fillStyle)
  ctx.fillStyle = '#ffffff'
  ctx.fillStyle = cleaned
  if (String(ctx.fillStyle) !== first) return 'invalid'
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(first)
  if (hex) return { r: parseInt(hex[1]!, 16), g: parseInt(hex[2]!, 16), b: parseInt(hex[3]!, 16), a: 1 }
  const rgba = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(first)
  if (rgba) return { r: +rgba[1]!, g: +rgba[2]!, b: +rgba[3]!, a: rgba[4] === undefined ? 1 : +rgba[4] }
  return null
}

function toHex(value: string): string | null {
  const c = readColor(value)
  if (!c || c === 'invalid') return null
  return '#' + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (n: number) => {
    const s = n / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Warnings only: a hard-to-read banner can still be saved. */
function colorWarnings(form: BannerConfig): string[] {
  const out: string[] = []
  const read = Object.fromEntries(COLORS.map(({ field }) => [field, readColor(form[field])])) as Record<
    ColorField,
    ReturnType<typeof readColor>
  >
  for (const { field, label } of COLORS) {
    if (read[field] === 'invalid') {
      out.push(`${label}: "${form[field]}" is not a color browsers recognize, so the banner leaves it out.`)
    }
  }
  const pairs: [ColorField, ColorField, string][] = [
    ['textColor', 'backgroundColor', 'Text on the background'],
    ['ctaTextColor', 'ctaColor', 'Button text on the button'],
  ]
  for (const [fg, bg, label] of pairs) {
    const f = read[fg]
    const b = read[bg]
    // Translucent colors depend on the page behind the banner: not checked.
    if (!f || !b || f === 'invalid' || b === 'invalid' || f.a < 1 || b.a < 1) continue
    const ratio = contrastRatio(f, b)
    if (ratio < MIN_CONTRAST) {
      out.push(
        `${label}: contrast is ${ratio.toFixed(1)}:1. WCAG AA asks for at least ${MIN_CONTRAST}:1, so some visitors may not be able to read it.`,
      )
    }
  }
  return out
}

// ── Editor ──────────────────────────────────────────────────────────────────

export function BannerEditor({ teamId, campaignId, step }: { teamId: string; campaignId: string; step?: string }) {
  const queryClient = useQueryClient()
  const { can, isPending: rolePending } = usePermissions()
  const canView = can('banners.view')
  const canEdit = can('banners.update')
  const queryKey = ['banner-config', teamId, campaignId]

  const {
    data: saved,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: () => api.banner.get(teamId, campaignId).then(pick),
    enabled: !!teamId && canView,
  })

  // Free plans show "Powered by GoPayLocal" on the banner; the preview does too.
  const { data: billing } = useQuery({
    queryKey: ['billing', teamId],
    queryFn: () => api.billing.get(teamId),
    enabled: !!teamId && canView,
  })
  const showBranding = !!billing && !billing.selfHosted && (billing.effectivePlan ?? billing.plan) === 'free'

  // What the preview's sample visitor sees: this campaign's discount for the
  // chosen country and your product's price, through the same localPricing()
  // as the banner endpoint, with today's rates.
  const { data: campaign } = useQuery({
    queryKey: ['campaign', teamId, campaignId],
    queryFn: () => api.campaigns.get(teamId, campaignId),
    enabled: !!teamId && canView,
  })
  const { data: product } = useQuery({
    queryKey: ['product', teamId, campaign?.productId],
    queryFn: () => api.products.get(teamId, campaign!.productId),
    enabled: !!teamId && canView && !!campaign,
  })
  const { data: parityGroups } = useQuery({
    queryKey: ['parity-groups', teamId],
    queryFn: () => api.parityGroups.list(teamId),
    enabled: !!teamId && canView,
  })
  const { data: fxView, isError: fxError } = useQuery({
    queryKey: ['fx-rates', teamId],
    queryFn: () => api.fxRates.get(teamId),
    enabled: !!teamId && canView,
    staleTime: 60 * 60 * 1000,
    retry: false,
  })
  const [sampleCode, setSampleCode] = useState<string | null>(null)

  const sampleCountries = useMemo<SampleCountry[]>(() => {
    if (!campaign || !parityGroups) return []
    const groups = workspaceParityGroupsFromList(parityGroups)
    return Object.entries(COUNTRY_NAMES)
      .map(([code, name]) => ({ code, name, discount: countryDiscount(campaign, code, groups).discount }))
      .filter((c) => c.discount > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [campaign, parityGroups])

  const sample = useMemo((): { data: TemplateData; country: SampleCountry | null; pricing: LocalPricing | null } => {
    const country =
      sampleCountries.find((c) => c.code === sampleCode) ??
      sampleCountries.find((c) => c.code === 'IN') ??
      sampleCountries[0] ??
      null
    if (!country || !campaign) return { data: FALLBACK_SAMPLE, country: null, pricing: null }
    const base = {
      country: country.code,
      countryName: country.name,
      discount: country.discount,
      code: sampleCouponCode(country.code, country.discount),
    }
    const pricing = product
      ? localPricing({
          basePrice: product.basePrice,
          baseCurrency: product.currency,
          discountPercent: country.discount,
          country: country.code,
          strategy: campaign.charmPricingStrategy,
          fx: fxDocOf(fxView),
          now: Date.now(),
          excludedCurrencies: excludedOf(fxView),
        })
      : null
    if (!pricing) return { data: base, country, pricing: null }
    return {
      data: {
        ...base,
        currencyCode: pricing.currencyCode,
        currencySymbol: pricing.currencySymbol,
        localPrice: pricing.localPrice,
        localOriginalPrice: pricing.localOriginalPrice,
      },
      country,
      pricing,
    }
  }, [sampleCountries, sampleCode, campaign, product, fxView])

  const [draft, setDraft] = useState<BannerConfig | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const messageRef = useRef<HTMLTextAreaElement>(null)

  const form = draft ?? saved ?? null
  const changes = saved && draft ? changedFields(saved, draft) : {}
  const dirty = Object.keys(changes).length > 0
  const warnings = useMemo(() => (form ? colorWarnings(form) : []), [form])

  const save = useMutation({
    mutationFn: (data: Partial<BannerConfig>) => api.banner.update(teamId, campaignId, data),
    onSuccess: (config) => {
      queryClient.setQueryData(queryKey, pick(config))
      setDraft(null)
      setErrors({})
      toast.success('Banner saved', {
        description: 'New visitors usually see it within about a minute; visitors who already saw the banner within 5 minutes.',
      })
    },
    onError: (err) => {
      setErrors(serverFieldErrors(err))
      toast.error('Save failed', { description: err.message || 'Please try again.' })
    },
  })

  if (rolePending || !canView) return null

  if (isError) {
    return (
      <div className="border border-border">
        <div className="border-b border-border px-4 py-2.5">
          <span className="text-[13px] font-medium text-text-primary">Banner</span>
        </div>
        <div className="flex items-center justify-between gap-4 p-5">
          <p className="text-[13px] text-text-secondary">The banner settings could not be loaded.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="border border-border px-3 py-1.5 text-[13px] font-medium text-text-primary hover:bg-surface"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (isPending || !form) {
    return (
      <div className="flex h-16 items-center justify-center border border-border">
        <div className="h-5 w-5 animate-spin rounded-full border-4 border-border border-t-brand" />
      </div>
    )
  }

  const set = <K extends Field>(field: K, value: BannerConfig[K]) => {
    setDraft({ ...form, [field]: value })
    if (errors[field]) setErrors({ ...errors, [field]: undefined })
  }

  const insertPlaceholder = (name: Placeholder) => {
    const el = messageRef.current
    const token = `{{${name}}}`
    const value = form.messageTemplate
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    set('messageTemplate', value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const handleSave = () => {
    const parsed = updateBannerConfigSchema.safeParse(changes)
    if (!parsed.success) {
      const next: FieldErrors = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (isField(field) && !next[field]) next[field] = messageFor(field, issue.code, issue.message)
      }
      setErrors(next)
      return
    }
    save.mutate(parsed.data)
  }

  const readOnly = !canEdit
  const inputClass =
    'block w-full border border-control bg-bg px-3 py-2 text-sm text-text-primary focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:text-text-secondary'

  return (
    <section aria-labelledby="banner-title" className="border border-border bg-panel">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-6 py-4">
        {step && <span className="font-mono text-xs text-brand-text">{step}</span>}
        <h2 id="banner-title" className="font-display text-lg font-semibold text-text-primary">
          Banner
        </h2>
        <span className="text-[13px] text-text-muted">What a visitor sees on your pricing page.</span>
        {readOnly && <span className="ml-auto text-[13px] text-text-secondary">View only</span>}
      </div>

      {/* Settings on the left, the preview on the right (above the settings on
          a phone). The preview stays in view while the settings scroll. */}
      <div className="grid grid-cols-1 gap-px bg-border lg:grid-cols-2">
        <div className="min-w-0 bg-panel-inset p-6 lg:order-2">
          <div className="lg:sticky lg:top-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">Preview</p>
          {sampleCountries.length > 0 && (
            <div className="mb-3">
              <label className="block text-[13px] text-text-secondary">Preview as a visitor from</label>
              <Select value={sample.country?.code} onValueChange={setSampleCode}>
                <SelectTrigger className="mt-1 w-full" aria-label="Preview as a visitor from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {sampleCountries.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name} ({c.discount}% off)
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          )}
          <BannerPreview config={form} sample={sample.data} showBranding={showBranding} />
          <p className="mt-1.5 text-[13px] text-text-secondary">
            {`Sample visitor from ${sample.data.countryName} with ${sample.data.discount}% off and the sample code ${sample.data.code}.`}
            {showBranding && ' On the Free plan the banner also shows a "Powered by GoPayLocal" link.'}
          </p>
          {sample.pricing && product && (
            <p className="mt-1 text-[13px] text-text-secondary" data-testid="preview-pricing">
              {previewPricingNote(
                sample.pricing,
                product.currency,
                sample.country!.code,
                !!fxDocOf(fxView) && !fxError,
                excludedOf(fxView),
              )}
            </p>
          )}
          </div>
        </div>

        <fieldset disabled={readOnly} className="min-w-0 space-y-4 bg-panel p-6 lg:order-1">
          <div>
            <label className="block text-sm font-medium text-text-primary">Position</label>
            <Select
              value={form.position}
              onValueChange={(v) => set('position', v as BannerPosition)}
              disabled={readOnly}
            >
              <SelectTrigger className="mt-1 w-full" aria-label="Position">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {POSITIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {errors.position && <ErrorText className="mt-1.5">{errors.position}</ErrorText>}
          </div>

          <div>
            <label htmlFor="banner-message" className="block text-sm font-medium text-text-primary">
              Message
            </label>
            <textarea
              id="banner-message"
              ref={messageRef}
              rows={3}
              maxLength={MAX_BANNER_MESSAGE_LENGTH}
              value={form.messageTemplate}
              onChange={(e) => set('messageTemplate', e.target.value)}
              className={`mt-1 ${inputClass}`}
            />
            {errors.messageTemplate && (
              <ErrorText className="mt-1.5">{errors.messageTemplate}</ErrorText>
            )}
            <p className="mt-1.5 text-[13px] text-text-secondary">
              {readOnly ? 'Placeholders the message can use:' : 'Placeholders (click to insert at the cursor):'}
            </p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
              {PLACEHOLDERS.map((name) => (
                <div key={name} className="contents">
                  <dt>
                    <button
                      type="button"
                      onClick={() => insertPlaceholder(name)}
                      className="border border-border px-2 py-0.5 font-mono text-[12px] text-text-primary transition-colors hover:bg-surface disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      {`{{${name}}}`}
                    </button>
                  </dt>
                  <dd className="text-[13px] text-text-secondary">{PLACEHOLDER_HELP[name]}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div>
            <label htmlFor="banner-cta" className="block text-sm font-medium text-text-primary">
              Button text
            </label>
            <input
              id="banner-cta"
              type="text"
              maxLength={MAX_BANNER_CTA_LENGTH}
              value={form.ctaText}
              onChange={(e) => set('ctaText', e.target.value)}
              className={`mt-1 ${inputClass}`}
            />
            {errors.ctaText ? (
              <ErrorText className="mt-1.5">{errors.ctaText}</ErrorText>
            ) : (
              <p className="mt-1.5 text-[13px] text-text-secondary">
                The button copies the coupon code. It only appears when the visitor has a code.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {COLORS.map(({ field, label }) => (
              <div key={field}>
                <label htmlFor={`banner-${field}`} className="block text-sm font-medium text-text-primary">
                  {label} color
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={`${label} color picker`}
                    value={toHex(form[field]) ?? '#000000'}
                    onChange={(e) => set(field, e.target.value)}
                    className="h-9 w-10 shrink-0 cursor-pointer border border-border bg-bg p-0.5 disabled:cursor-not-allowed"
                  />
                  <input
                    id={`banner-${field}`}
                    type="text"
                    spellCheck={false}
                    maxLength={MAX_BANNER_COLOR_LENGTH}
                    value={form[field]}
                    onChange={(e) => set(field, e.target.value)}
                    className={`font-mono ${inputClass}`}
                  />
                </div>
                {errors[field] && <ErrorText className="mt-1.5">{errors[field]}</ErrorText>}
              </div>
            ))}
          </div>

          {warnings.length > 0 && (
            <div className="border border-warning-border bg-warning-light p-4">
              <p className="text-sm font-semibold text-warning">Check these colors</p>
              <ul className="mt-1 space-y-1 text-[13px] text-text-primary">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              {!readOnly && <p className="mt-2 text-[13px] text-text-primary">You can still save.</p>}
            </div>
          )}

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={form.showFlag}
                onChange={(e) => set('showFlag', e.target.checked)}
                className="accent-brand"
              />
              Show the visitor's country flag
            </label>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={form.showCloseBtn}
                onChange={(e) => set('showCloseBtn', e.target.checked)}
                className="accent-brand"
              />
              Show a close button
            </label>
          </div>
        </fieldset>
      </div>

      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-6 py-3.5">
          {dirty && <span className="mr-auto text-[13px] text-warning">Unsaved changes</span>}
          <button
            type="button"
            onClick={() => {
              setDraft(null)
              setErrors({})
            }}
            disabled={!dirty || save.isPending}
            className={btnSecondary}
          >
            Discard changes
          </button>
          <button type="button" onClick={handleSave} disabled={!dirty || save.isPending} className={btnPrimary}>
            {save.isPending ? 'Saving…' : 'Save banner'}
          </button>
        </div>
      ) : (
        <p className="border-t border-border px-6 py-3.5 text-[13px] text-text-secondary">
          Your role can view this banner but not change it.
        </p>
      )}
    </section>
  )
}

/**
 * The real banner, drawn into a frame. The frame has a transform, which makes
 * it the containing block for the banner's position:fixed elements, so each
 * position shows inside the frame instead of over the dashboard.
 */
function BannerPreview({
  config,
  sample,
  showBranding,
}: {
  config: BannerConfig
  sample: TemplateData
  showBranding: boolean
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  // Closing the preview banner draws it again rather than leaving an empty frame.
  const [round, setRound] = useState(0)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const data: BannerData = {
      show: true,
      ...sample,
      localPrice: sample.localPrice ?? undefined,
      localOriginalPrice: sample.localOriginalPrice ?? undefined,
      showBranding,
      banner: config,
    }
    const host = render(
      data,
      mount,
      (event) => {
        if (event === 'dismiss') setRound((r) => r + 1)
      },
      true,
    )
    return () => host.remove()
  }, [config, sample, showBranding, round])

  return (
    <div
      role="group"
      aria-label="Banner preview"
      className="relative h-56 overflow-hidden border border-border bg-surface"
      style={{ transform: 'translateZ(0)' }}
    >
      {/* Stand-in page content, so the banner's position reads at a glance. */}
      <div aria-hidden="true" className="space-y-2.5 px-6 py-14">
        <div className="h-3 w-2/5 bg-border" />
        <div className="h-2 w-4/5 bg-border/60" />
        <div className="h-2 w-3/5 bg-border/60" />
      </div>
      <div ref={mountRef} />
    </div>
  )
}

/** One line under the preview on where its prices come from. */
function previewPricingNote(
  p: LocalPricing,
  productCurrency: string,
  country: string,
  ratesAvailable: boolean,
  excluded: ReadonlySet<string>,
): string {
  const shown = `${formatMoney(p.localPrice, p.currencyCode)} (was ${formatMoney(p.localOriginalPrice, p.currencyCode)})`
  if (p.fxAsOf) {
    return `${shown} is an estimate: your price converted at the ${p.fxAsOf} exchange rate and rounded with this campaign's charm pricing. Your payment provider charges the exact price in ${p.baseCurrencyCode}.`
  }
  const visitorCurrency = currencyForCountry(country)
  if (visitorCurrency === p.baseCurrencyCode || !visitorCurrency) {
    return `${shown}: visitors from this country see the exact price in ${productCurrency}.`
  }
  if (excluded.has(visitorCurrency)) {
    return `${shown}: ${visitorCurrency} is excluded from conversion on this deployment, so visitors from this country see the exact price in ${productCurrency}.`
  }
  return ratesAvailable
    ? `${shown}: there is no usable ${visitorCurrency} exchange rate today, so visitors from this country see the exact price in ${productCurrency}.`
    : `${shown}: exchange rates are not available right now, so visitors see the exact price in ${productCurrency}.`
}
