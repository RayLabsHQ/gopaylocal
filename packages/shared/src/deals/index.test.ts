import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEAL_MESSAGE,
  DEFAULT_DEAL_MESSAGE_NO_CODE,
  HOLIDAY_PRESETS,
  blackFriday,
  cyberMonday,
  dealDays,
  dealPhase,
  dealReplacesCountryDiscount,
  dealWindowForDays,
  defaultDealMessage,
  fillDealMessage,
  formatDealEnd,
  holidayDays,
  nextHolidayOccurrence,
  pickActiveDeal,
  utcDay,
} from "./index";
import { createDealSchema, dealWindowError, updateDealSchema } from "../validation/index";

const at = (iso: string) => Date.parse(iso);

describe("dealPhase", () => {
  const deal = { startsAt: at("2026-11-27T00:00:00Z"), endsAt: at("2026-12-01T00:00:00Z") };

  it("is scheduled before the start, live from the start, ended from the end", () => {
    expect(dealPhase(deal, deal.startsAt - 1)).toBe("scheduled");
    expect(dealPhase(deal, deal.startsAt)).toBe("live");
    expect(dealPhase(deal, deal.endsAt - 1)).toBe("live");
    expect(dealPhase(deal, deal.endsAt)).toBe("ended");
  });
});

describe("pickActiveDeal", () => {
  const now = at("2026-11-28T12:00:00Z");
  const deal = (id: string, discount: number, startsAt: string, endsAt: string) => ({
    id,
    discount,
    startsAt: at(startsAt),
    endsAt: at(endsAt),
  });

  it("returns null without deals, and for deals that have not started or have ended", () => {
    expect(pickActiveDeal(undefined, now)).toBeNull();
    expect(pickActiveDeal([], now)).toBeNull();
    expect(
      pickActiveDeal(
        [
          deal("later", 40, "2026-12-24T00:00:00Z", "2026-12-27T00:00:00Z"),
          deal("over", 40, "2026-11-01T00:00:00Z", "2026-11-28T12:00:00Z"),
        ],
        now,
      ),
    ).toBeNull();
  });

  it("picks the largest percentage of the deals running now", () => {
    const picked = pickActiveDeal(
      [
        deal("a", 20, "2026-11-27T00:00:00Z", "2026-12-01T00:00:00Z"),
        deal("b", 40, "2026-11-27T00:00:00Z", "2026-12-01T00:00:00Z"),
        deal("c", 30, "2026-11-27T00:00:00Z", "2026-12-01T00:00:00Z"),
      ],
      now,
    );
    expect(picked?.id).toBe("b");
  });

  it("breaks a tie by the earlier end, then by the lower id, whatever the order", () => {
    const sooner = deal("z", 40, "2026-11-27T00:00:00Z", "2026-11-29T00:00:00Z");
    const later = deal("a", 40, "2026-11-27T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(pickActiveDeal([later, sooner], now)?.id).toBe("z");
    expect(pickActiveDeal([sooner, later], now)?.id).toBe("z");

    const twinA = deal("a", 40, "2026-11-27T00:00:00Z", "2026-12-01T00:00:00Z");
    const twinB = deal("b", 40, "2026-11-27T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(pickActiveDeal([twinB, twinA], now)?.id).toBe("a");
  });

  it("ignores a deal without a percentage", () => {
    expect(pickActiveDeal([deal("zero", 0, "2026-11-27T00:00:00Z", "2026-12-01T00:00:00Z")], now)).toBeNull();
  });
});

describe("dealReplacesCountryDiscount", () => {
  it("offers the deal when it is larger than or equal to the country's discount", () => {
    expect(dealReplacesCountryDiscount(40, 0)).toBe(true);
    expect(dealReplacesCountryDiscount(40, 30)).toBe(true);
    expect(dealReplacesCountryDiscount(40, 40)).toBe(true);
  });

  it("keeps the country's discount when that is larger", () => {
    expect(dealReplacesCountryDiscount(40, 41)).toBe(false);
    expect(dealReplacesCountryDiscount(0, 0)).toBe(false);
  });
});

describe("deal message", () => {
  it("shows the last day the deal runs, in UTC", () => {
    expect(formatDealEnd(at("2026-11-30T23:59:00Z"))).toBe("30 November");
    // Ends exactly at midnight: the deal ran through the day before.
    expect(formatDealEnd(at("2026-12-01T00:00:00Z"))).toBe("30 November");
    expect(formatDealEnd(at("2027-01-01T00:00:00Z"))).toBe("31 December");
    expect(formatDealEnd(Number.NaN)).toBe("");
  });

  it("fills {{deal}} and {{ends}} and leaves the banner's placeholders alone", () => {
    const filled = fillDealMessage(DEFAULT_DEAL_MESSAGE, { name: "Black Friday", endsAt: at("2026-12-01T00:00:00Z") });
    expect(filled).toBe("Black Friday: {{discount}}% off with code {{code}}. Ends 30 November.");
  });

  it("fills every occurrence", () => {
    expect(fillDealMessage("{{deal}} {{deal}} {{ends}}", { name: "Diwali", endsAt: at("2026-11-11T00:00:00Z") })).toBe(
      "Diwali Diwali 10 November",
    );
  });

  it("has a default without a code for a deal that has none", () => {
    expect(defaultDealMessage("provider")).toBe(DEFAULT_DEAL_MESSAGE);
    expect(defaultDealMessage("manual")).toBe(DEFAULT_DEAL_MESSAGE);
    expect(defaultDealMessage("none")).toBe(DEFAULT_DEAL_MESSAGE_NO_CODE);
    expect(DEFAULT_DEAL_MESSAGE_NO_CODE).not.toContain("{{code}}");
  });
});

describe("holiday presets", () => {
  it("puts Black Friday on the day after the fourth Thursday of November", () => {
    expect(blackFriday(2026)).toEqual({ month: 11, day: 27 });
    expect(blackFriday(2027)).toEqual({ month: 11, day: 26 });
    expect(blackFriday(2028)).toEqual({ month: 11, day: 24 });
    expect(blackFriday(2029)).toEqual({ month: 11, day: 23 });
    expect(blackFriday(2030)).toEqual({ month: 11, day: 29 });
  });

  it("puts Cyber Monday three days later, in December when it falls there", () => {
    expect(cyberMonday(2026)).toEqual({ month: 11, day: 30 });
    expect(cyberMonday(2030)).toEqual({ month: 12, day: 2 });
  });

  it("has unique ids and a positive length for every preset", () => {
    expect(new Set(HOLIDAY_PRESETS.map((p) => p.id)).size).toBe(HOLIDAY_PRESETS.length);
    for (const preset of HOLIDAY_PRESETS) expect(preset.days).toBeGreaterThan(0);
  });

  const preset = (id: string) => HOLIDAY_PRESETS.find((p) => p.id === id)!;

  it("suggests this year's occurrence while it can still run", () => {
    expect(nextHolidayOccurrence(preset("black-friday"), { year: 2026, month: 11, day: 21 })).toEqual({
      year: 2026,
      month: 11,
      day: 27,
      days: 4,
    });
    // The last of its four days still counts.
    expect(nextHolidayOccurrence(preset("black-friday"), { year: 2026, month: 11, day: 30 })?.year).toBe(2026);
  });

  it("suggests next year's once this year's is over", () => {
    expect(nextHolidayOccurrence(preset("black-friday"), { year: 2026, month: 12, day: 1 })).toEqual({
      year: 2027,
      month: 11,
      day: 26,
      days: 4,
    });
    expect(nextHolidayOccurrence(preset("new-year"), { year: 2026, month: 11, day: 21 })).toEqual({
      year: 2027,
      month: 1,
      day: 1,
      days: 3,
    });
  });

  it("uses the table for lunar holidays and gives up past its end", () => {
    expect(nextHolidayOccurrence(preset("diwali"), { year: 2026, month: 11, day: 21 })).toEqual({
      year: 2027,
      month: 10,
      day: 29,
      days: 3,
    });
    expect(nextHolidayOccurrence(preset("lunar-new-year"), { year: 2026, month: 11, day: 21 })).toEqual({
      year: 2027,
      month: 2,
      day: 6,
      days: 3,
    });
    expect(nextHolidayOccurrence(preset("diwali"), { year: 2031, month: 1, day: 1 })).toBeNull();
  });
});

describe("deal validation", () => {
  const valid = {
    name: "Black Friday",
    discountPercent: 40,
    startsAt: "2026-11-27T00:00:00Z",
    endsAt: "2026-12-01T00:00:00Z",
  };

  it("accepts a deal with a name, a whole percentage and a window", () => {
    expect(createDealSchema.safeParse(valid).success).toBe(true);
    expect(createDealSchema.safeParse({ ...valid, code: "BF40", messageTemplate: "{{deal}}!" }).success).toBe(true);
    expect(createDealSchema.safeParse({ ...valid, startsAt: "2026-11-27T00:00:00+05:30" }).success).toBe(true);
  });

  it("trims the name", () => {
    const parsed = createDealSchema.safeParse({ ...valid, name: "  Diwali  " });
    expect(parsed.success && parsed.data.name).toBe("Diwali");
  });

  it("refuses a percentage that is not a whole number from 1 to 100", () => {
    for (const discountPercent of [0, 101, 12.5, -5]) {
      expect(createDealSchema.safeParse({ ...valid, discountPercent }).success).toBe(false);
    }
    expect(createDealSchema.safeParse({ ...valid, discountPercent: 100 }).success).toBe(true);
  });

  it("refuses a window that is backwards, empty or longer than a year", () => {
    expect(createDealSchema.safeParse({ ...valid, endsAt: valid.startsAt }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...valid, endsAt: "2026-11-26T00:00:00Z" }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...valid, endsAt: "2027-11-29T00:00:00Z" }).success).toBe(false);
    expect(dealWindowError(valid.startsAt, "2027-11-28T00:00:00Z")).toBeNull();
    expect(dealWindowError("nonsense", valid.endsAt)).toMatch(/dates/);
  });

  it("refuses a date without an offset, an empty name and a code with spaces", () => {
    expect(createDealSchema.safeParse({ ...valid, startsAt: "2026-11-27T00:00:00" }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...valid, startsAt: "27 November" }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...valid, name: "x".repeat(61) }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...valid, code: "BLACK FRIDAY" }).success).toBe(false);
  });

  it("lets an update change the name, the window and the message, and nothing else", () => {
    expect(updateDealSchema.safeParse({ name: "Cyber Week" }).success).toBe(true);
    expect(updateDealSchema.safeParse({ endsAt: "2026-12-03T00:00:00Z" }).success).toBe(true);
    expect(updateDealSchema.safeParse({}).success).toBe(false);
    const parsed = updateDealSchema.safeParse({ name: "Cyber Week", discountPercent: 50 });
    expect(parsed.success && "discountPercent" in parsed.data).toBe(false);
  });
});

describe("whole-day windows (the dashboard's form)", () => {
  it("a deal on whole UTC days runs from 00:00 on the first to 24:00 on the last", () => {
    expect(dealWindowForDays("2026-11-27", "2026-11-30")).toEqual({
      startsAt: "2026-11-27T00:00:00.000Z",
      endsAt: "2026-12-01T00:00:00.000Z",
    });
    // One day.
    expect(dealWindowForDays("2026-12-31", "2026-12-31")).toEqual({
      startsAt: "2026-12-31T00:00:00.000Z",
      endsAt: "2027-01-01T00:00:00.000Z",
    });
  });

  it("refuses days that are not dates and a last day before the first", () => {
    expect(dealWindowForDays("2026-11-30", "2026-11-27")).toBeNull();
    expect(dealWindowForDays("", "2026-11-27")).toBeNull();
    expect(dealWindowForDays("2026-02-31", "2026-03-05")).toBeNull();
    expect(dealWindowForDays("27/11/2026", "30/11/2026")).toBeNull();
  });

  it("the last day of a window is the day {{ends}} shows", () => {
    const window = dealWindowForDays("2026-11-27", "2026-11-30")!;
    const days = dealDays(at(window.startsAt), at(window.endsAt));
    expect(days).toEqual({ firstDay: "2026-11-27", lastDay: "2026-11-30" });
    expect(formatDealEnd(at(window.endsAt))).toBe("30 November");
    // A window that does not end at midnight still ends on the day it reaches.
    expect(dealDays(at("2026-11-27T09:00:00Z"), at("2026-11-30T17:00:00Z"))).toEqual({
      firstDay: "2026-11-27",
      lastDay: "2026-11-30",
    });
    expect(utcDay(at("2026-11-27T23:59:59.999Z"))).toBe("2026-11-27");
  });

  it("a holiday occurrence gives the days of its suggested length", () => {
    const blackFridayPreset = HOLIDAY_PRESETS.find((p) => p.id === "black-friday")!;
    const next = nextHolidayOccurrence(blackFridayPreset, { year: 2026, month: 11, day: 21 })!;
    expect(holidayDays(next)).toEqual({ firstDay: "2026-11-27", lastDay: "2026-11-30" });
    // Across a month and a year end.
    expect(holidayDays({ year: 2026, month: 12, day: 31, days: 3 })).toEqual({
      firstDay: "2026-12-31",
      lastDay: "2027-01-02",
    });
    expect(holidayDays({ year: 2027, month: 2, day: 14, days: 1 })).toEqual({
      firstDay: "2027-02-14",
      lastDay: "2027-02-14",
    });
  });
});
