// ── Currency minor units (ISO 4217) ─────────────────────────────────────────
// Moved to packages/shared/src/currency/exponents.ts (MIT), where the charm
// pricing code and the SDKs use the same table. Re-exported here for the API's
// existing importers (redemption and revenue services, provider adapters).

export {
  ZERO_DECIMAL_CURRENCIES,
  THREE_DECIMAL_CURRENCIES,
  FOUR_DECIMAL_CURRENCIES,
  normalizeCurrency,
  minorUnitExponent,
  minorToMajor,
} from "@gopaylocal/shared/currency";
