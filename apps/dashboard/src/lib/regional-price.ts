import { useQuery } from '@tanstack/react-query'
import { regionalOfferFromProPrice, type RegionalOffer } from '@gopaylocal/shared/currency'

// The hosted service prices Pro per country with GoPayLocal itself, and Dodo
// Payments charges that price (apps/api/src/services/house-pricing.service.ts).
// GET /v1/pricing/pro answers with what Dodo charges in the visitor's country;
// a self-hosted API, which has no billing, always answers with the list price.
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787'

/** This visitor's Pro price, or null when they pay the list price ($19). */
export function useRegionalProPrice(enabled = true): RegionalOffer | null {
  const { data } = useQuery({
    queryKey: ['regional-pro-price'],
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/v1/pricing/pro`)
      if (!res.ok) return null
      return regionalOfferFromProPrice(await res.json())
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
