import { useQuery } from '@tanstack/react-query'
import { PLAN_PRICES_USD } from '@gopaylocal/shared/constants'
import { regionalOfferFromAnswer, type RegionalOffer } from '@gopaylocal/shared/currency'

// The hosted service prices Pro with GoPayLocal itself: the public key of its
// house workspace, whose campaign holds each country's discount. Dodo Payments
// charges the same per-country price (apps/api/src/services/house-pricing.service.ts).
// Unset (self-hosted, local development): everyone sees the list price.
const HOUSE_KEY = import.meta.env.VITE_GOPAYLOCAL_PUBLIC_KEY as string | undefined
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787'

/** This visitor's Pro price, or null when they pay the list price ($19). */
export function useRegionalProPrice(enabled = true): RegionalOffer | null {
  const { data } = useQuery({
    queryKey: ['regional-pro-price'],
    enabled: enabled && !!HOUSE_KEY,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/v1/banner/config/${encodeURIComponent(HOUSE_KEY!)}`)
      if (!res.ok) return null
      return regionalOfferFromAnswer(await res.json(), PLAN_PRICES_USD.pro.month, 'USD')
    },
  })
  return data ?? null
}

/** "₹479", "$5.70": the amount as the visitor's locale would expect, in its own currency. */
export function formatCharge(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount}`
  }
}
