import { COUNTRY_NAMES } from '@gopaylocal/shared'

/** "India" for "IN"; the code itself when the name isn't known. */
export function countryName(code: string | null): string {
  if (!code) return 'Unknown'
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase()
}

/** The flag emoji for a two-letter country code, or '' when it isn't one. */
export function flagEmoji(code: string | null): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}
