/**
 * Holiday deals: a named percentage discount with a start and an end, attached
 * to a campaign, with one discount code that works for every visitor.
 *
 * While a deal runs, a visitor is offered the larger of the two discounts: the
 * deal's, or their country's. The rule lives here (pickActiveDeal,
 * dealReplacesCountryDiscount) so the banner endpoint, its tests and the
 * dashboard's wording cannot disagree.
 *
 * No imports: the API, the dashboard and the docs build all load this file.
 */

// ── Limits ──────────────────────────────────────────────────────────────────

export const MAX_DEAL_NAME_LENGTH = 60;
/** Deals of one campaign that have not ended yet. */
export const MAX_DEALS_PER_CAMPAIGN = 20;
/** Longest time between a deal's start and its end. */
export const MAX_DEAL_DAYS = 366;
export const MIN_DEAL_PERCENT = 1;
export const MAX_DEAL_PERCENT = 100;
/** A code the merchant made themselves (a campaign without a payment integration). */
export const DEAL_MANUAL_CODE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

const DAY_MS = 86_400_000;
export const MAX_DEAL_DURATION_MS = MAX_DEAL_DAYS * DAY_MS;

// ── Where a deal's code comes from ──────────────────────────────────────────

/**
 * - `provider`: GoPayLocal creates the code in the campaign's payment platform.
 *   The deal is shown only while that code exists there.
 * - `manual`: the merchant typed a code they created themselves.
 * - `none`: no code; the response still carries the deal and its percentage.
 */
export const DEAL_CODE_SOURCES = ['provider', 'manual', 'none'] as const;
export type DealCodeSource = (typeof DEAL_CODE_SOURCES)[number];

// ── Message ─────────────────────────────────────────────────────────────────

/**
 * Placeholders a deal's message can use on top of the banner's own
 * (`{{discount}}`, `{{code}}`, `{{localPrice}}`, ...). The API fills these two
 * before it answers, so every version of the banner script shows them.
 */
export const DEAL_PLACEHOLDERS = ['deal', 'ends'] as const;

export const DEFAULT_DEAL_MESSAGE = '{{deal}}: {{discount}}% off with code {{code}}. Ends {{ends}}.';
export const DEFAULT_DEAL_MESSAGE_NO_CODE = '{{deal}}: {{discount}}% off. Ends {{ends}}.';

export function defaultDealMessage(codeSource: DealCodeSource): string {
  return codeSource === 'none' ? DEFAULT_DEAL_MESSAGE_NO_CODE : DEFAULT_DEAL_MESSAGE;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * A deal's end as text for `{{ends}}`: the last day the deal runs, in UTC, as
 * "30 November". A deal that ends exactly at midnight UTC ran through the day
 * before, so that day is the one shown.
 */
export function formatDealEnd(endsAtMs: number): string {
  if (!Number.isFinite(endsAtMs)) return '';
  const lastMoment = new Date(endsAtMs - 1);
  return `${lastMoment.getUTCDate()} ${MONTHS[lastMoment.getUTCMonth()]}`;
}

/** Fill `{{deal}}` and `{{ends}}`; every other placeholder is left for the banner. */
export function fillDealMessage(template: string, deal: { name: string; endsAt: number }): string {
  return template.replace(/\{\{(deal|ends)\}\}/g, (_match, name: string) =>
    name === 'deal' ? deal.name : formatDealEnd(deal.endsAt),
  );
}

// ── Which offer a visitor gets ──────────────────────────────────────────────

/** A deal with its window as milliseconds since the epoch: [startsAt, endsAt). */
export interface TimedDeal {
  id: string;
  discount: number;
  startsAt: number;
  endsAt: number;
}

export type DealPhase = 'scheduled' | 'live' | 'ended';

export function dealPhase(deal: { startsAt: number; endsAt: number }, now: number): DealPhase {
  if (now >= deal.endsAt) return 'ended';
  return now >= deal.startsAt ? 'live' : 'scheduled';
}

/**
 * The deal in force at `now`, or null. Of several running at once: the largest
 * percentage, then the one that ends first, then the lowest id.
 */
export function pickActiveDeal<T extends TimedDeal>(deals: readonly T[] | null | undefined, now: number): T | null {
  let best: T | null = null;
  for (const deal of deals ?? []) {
    if (!(deal.discount > 0) || dealPhase(deal, now) !== 'live') continue;
    if (
      !best ||
      deal.discount > best.discount ||
      (deal.discount === best.discount &&
        (deal.endsAt < best.endsAt || (deal.endsAt === best.endsAt && deal.id < best.id)))
    ) {
      best = deal;
    }
  }
  return best;
}

/**
 * Whether a running deal is offered in place of the visitor's country
 * discount: when it is at least as large. `countryPercent` is 0 for a visitor
 * whose country has no discount.
 */
export function dealReplacesCountryDiscount(dealPercent: number, countryPercent: number): boolean {
  return dealPercent > 0 && dealPercent >= countryPercent;
}

// ── Whole days ──────────────────────────────────────────────────────────────
// A deal's window is two instants. The dashboard's form works in whole UTC
// days, the same days `{{ends}}` is written in, so the last day a merchant
// picks is the day the banner says.

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Midnight UTC at the start of a "YYYY-MM-DD" day, or null when it is not a date. */
function dayStart(day: string): number | null {
  const m = DAY_PATTERN.exec(day);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Date.UTC rolls 2026-02-31 over to March: such a day is not a date.
  return utcDay(ms) === day ? ms : null;
}

/** The UTC day of an instant as "YYYY-MM-DD". */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The window of a deal that runs on whole UTC days: from 00:00 on `firstDay`
 * to 24:00 on `lastDay` (both "YYYY-MM-DD"). Null when a day is not a date or
 * the last day is before the first.
 */
export function dealWindowForDays(firstDay: string, lastDay: string): { startsAt: string; endsAt: string } | null {
  const start = dayStart(firstDay);
  const last = dayStart(lastDay);
  if (start === null || last === null || last < start) return null;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(last + DAY_MS).toISOString() };
}

/** The first and the last UTC day a window covers (the last day is the one `{{ends}}` shows). */
export function dealDays(startsAtMs: number, endsAtMs: number): { firstDay: string; lastDay: string } {
  return { firstDay: utcDay(startsAtMs), lastDay: utcDay(endsAtMs - 1) };
}

// ── Holiday presets ─────────────────────────────────────────────────────────
// Suggestions for the dashboard's form: a name, the day, and a length. Nothing
// is enforced; a deal can have any name and any dates.

export interface HolidayPreset {
  id: string;
  name: string;
  /** Suggested length in days, starting on the holiday. */
  days: number;
  /** The day it falls on in `year` (month 1-12), or null when not known for that year. */
  date(year: number): { month: number; day: number } | null;
}

const fixed = (month: number, day: number) => () => ({ month, day });

/** Holidays that follow a lunar calendar, by year. Extend the tables as years are added. */
function fromTable(table: Readonly<Record<number, readonly [number, number]>>) {
  return (year: number) => {
    const entry = table[year];
    return entry ? { month: entry[0], day: entry[1] } : null;
  };
}

/** Black Friday: the day after the fourth Thursday of November. */
export function blackFriday(year: number): { month: number; day: number } {
  const firstWeekday = new Date(Date.UTC(year, 10, 1)).getUTCDay(); // 0 = Sunday
  const firstThursday = 1 + ((4 - firstWeekday + 7) % 7);
  return { month: 11, day: firstThursday + 21 + 1 };
}

/** Cyber Monday: the Monday after Black Friday (it can fall in December). */
export function cyberMonday(year: number): { month: number; day: number } {
  const friday = blackFriday(year);
  const monday = new Date(Date.UTC(year, friday.month - 1, friday.day + 3));
  return { month: monday.getUTCMonth() + 1, day: monday.getUTCDate() };
}

export const HOLIDAY_PRESETS: readonly HolidayPreset[] = [
  { id: 'new-year', name: 'New Year', days: 3, date: fixed(1, 1) },
  { id: 'valentines-day', name: "Valentine's Day", days: 1, date: fixed(2, 14) },
  {
    id: 'lunar-new-year',
    name: 'Lunar New Year',
    days: 3,
    date: fromTable({ 2026: [2, 17], 2027: [2, 6], 2028: [1, 26], 2029: [2, 13], 2030: [2, 3] }),
  },
  { id: 'halloween', name: 'Halloween', days: 1, date: fixed(10, 31) },
  {
    id: 'diwali',
    name: 'Diwali',
    days: 3,
    date: fromTable({ 2026: [11, 8], 2027: [10, 29], 2028: [10, 17], 2029: [11, 5], 2030: [10, 26] }),
  },
  { id: 'singles-day', name: "Singles' Day", days: 1, date: fixed(11, 11) },
  { id: 'black-friday', name: 'Black Friday', days: 4, date: blackFriday },
  { id: 'cyber-monday', name: 'Cyber Monday', days: 1, date: cyberMonday },
  { id: 'christmas', name: 'Christmas', days: 2, date: fixed(12, 25) },
];

export interface HolidayOccurrence {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  days: number;
}

/**
 * The next time a preset can still be run: its first occurrence whose last day
 * is today or later (`today` as a calendar date). Null when the preset's dates
 * are not known that far ahead.
 */
export function nextHolidayOccurrence(
  preset: HolidayPreset,
  today: { year: number; month: number; day: number },
): HolidayOccurrence | null {
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  for (let year = today.year; year <= today.year + 2; year++) {
    const date = preset.date(year);
    if (!date) continue;
    const lastDay = Date.UTC(year, date.month - 1, date.day + preset.days - 1);
    if (lastDay >= todayUtc) return { year, month: date.month, day: date.day, days: preset.days };
  }
  return null;
}

/** The first and the last day of a holiday occurrence, as "YYYY-MM-DD". */
export function holidayDays(occurrence: HolidayOccurrence): { firstDay: string; lastDay: string } {
  const start = Date.UTC(occurrence.year, occurrence.month - 1, occurrence.day);
  return { firstDay: utcDay(start), lastDay: utcDay(start + (occurrence.days - 1) * DAY_MS) };
}
