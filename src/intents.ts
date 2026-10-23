import { z } from "zod";

/**
 * Structured intent extraction.
 *
 * The LLM fills EXTRACTION_JSON_SCHEMA (Groq strict structured outputs), the result is
 * re-validated with Zod, and everything that decides behaviour (12/24-hour times, relative
 * dates, what is missing) is computed here deterministically. The LLM never resolves a
 * concrete date or instant: the phone does that in its own time zone.
 */

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const ACTION_TYPES = [
  "weather",
  "set_reminder",
  "set_alarm",
  "calendar_query",
  "chat",
] as const;

const DATE_KINDS = [
  "unspecified",
  "today",
  "tomorrow",
  "day_after_tomorrow",
  "in_days",
  "weekday",
  "calendar_date",
] as const;

const LlmActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  location: z
    .object({
      name: z.string(),
      region: z.string().nullable(),
      countryCode: z.string().nullable(),
    })
    .nullable(),
  date: z.object({
    kind: z.enum(DATE_KINDS),
    weekday: z.enum(WEEKDAYS).nullable(),
    isoDate: z.string().nullable(),
    offsetDays: z.number().int().nullable(),
  }),
  time: z
    .object({
      /** False when no time was given; hour/minute are then meaningless. */
      said: z.boolean(),
      hour: z.number().int(),
      minute: z.number().int(),
      meridiem: z.enum(["am", "pm", "none"]),
      partOfDay: z.enum(["morning", "afternoon", "evening", "night", "none"]),
    }),
  reminderText: z.string().nullable(),
  calendarRange: z.enum(["today", "tomorrow", "this_week"]).nullable(),
  wantsNextEvent: z.boolean(),
});

export const LlmExtractionSchema = z.object({
  actions: z.array(LlmActionSchema).min(1).max(3),
  reply: z.string(),
});

export type LlmAction = z.infer<typeof LlmActionSchema>;
export type LlmExtraction = z.infer<typeof LlmExtractionSchema>;

const nullable = (schema: object) => ({ anyOf: [{ type: "null" }, schema] });

/** JSON Schema for Groq strict mode: every field required, no additional properties. */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions", "reply"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "location",
          "date",
          "time",
          "reminderText",
          "calendarRange",
          "wantsNextEvent",
        ],
        properties: {
          type: { type: "string", enum: [...ACTION_TYPES] },
          location: nullable({
            type: "object",
            additionalProperties: false,
            required: ["name", "region", "countryCode"],
            properties: {
              name: { type: "string" },
              region: { type: ["string", "null"] },
              countryCode: { type: ["string", "null"] },
            },
          }),
          date: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "weekday", "isoDate", "offsetDays"],
            properties: {
              kind: { type: "string", enum: [...DATE_KINDS] },
              weekday: nullable({ type: "string", enum: [...WEEKDAYS] }),
              isoDate: { type: ["string", "null"] },
              offsetDays: { type: ["integer", "null"] },
            },
          },
          // Always present (not nullable): with an optional object the model sometimes
          // skipped a time that was clearly said.
          time: {
            type: "object",
            additionalProperties: false,
            required: ["said", "hour", "minute", "meridiem", "partOfDay"],
            properties: {
              said: { type: "boolean" },
              hour: { type: "integer" },
              minute: { type: "integer" },
              meridiem: { type: "string", enum: ["am", "pm", "none"] },
              partOfDay: {
                type: "string",
                enum: ["morning", "afternoon", "evening", "night", "none"],
              },
            },
          },
          reminderText: { type: ["string", "null"] },
          calendarRange: nullable({
            type: "string",
            enum: ["today", "tomorrow", "this_week"],
          }),
          wantsNextEvent: { type: "boolean" },
        },
      },
    },
    reply: { type: "string" },
  },
} as const;

// ---------------------------------------------------------------------------
// Normalised values shared with the app (see contract.ts).

/** A date description the phone resolves in its own time zone. */
export type DateSpec =
  | { kind: "unspecified" }
  | { kind: "relative"; days: number }
  | { kind: "weekday"; weekday: number }
  | { kind: "calendar_date"; year: number; month: number; day: number };

/** 24-hour wall-clock time. */
export interface Clock24 {
  hour: number;
  minute: number;
}

export type TimeResult =
  | { ok: true; time: Clock24 }
  | { ok: false; reason: "missing" | "invalid" }
  | { ok: false; reason: "ambiguous_meridiem"; hour: number; minute: number };

/**
 * Turns "7 baje subah", "5 PM", "17:30" or "raat 2 baje" into 24-hour time.
 * A bare 1–12 with no AM/PM and no part of day is ambiguous: we ask rather than guess.
 */
export function normalizeTime(time: LlmAction["time"]): TimeResult {
  if (!time.said) return { ok: false, reason: "missing" };
  const { minute, meridiem, partOfDay } = time;
  let hour = time.hour;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 24) {
    return { ok: false, reason: "invalid" };
  }
  if (hour === 24) hour = 0;
  if (hour === 0 || hour > 12) return { ok: true, time: { hour, minute } };

  // hour is 1..12 from here.
  if (meridiem === "am") {
    return { ok: true, time: { hour: hour === 12 ? 0 : hour, minute } };
  }
  if (meridiem === "pm") {
    return { ok: true, time: { hour: hour === 12 ? 12 : hour + 12, minute } };
  }
  switch (partOfDay) {
    case "morning":
      return { ok: true, time: { hour: hour === 12 ? 12 : hour, minute } };
    case "afternoon":
    case "evening":
      return { ok: true, time: { hour: hour === 12 ? 12 : hour + 12, minute } };
    case "night":
      // "raat 10 baje" = 22:00, "raat 12 baje" = midnight, "raat 2 baje" = 02:00.
      if (hour === 12) return { ok: true, time: { hour: 0, minute } };
      if (hour <= 4) return { ok: true, time: { hour, minute } };
      return { ok: true, time: { hour: hour + 12, minute } };
    default:
      return { ok: false, reason: "ambiguous_meridiem", hour, minute };
  }
}

export type DateResult =
  | { ok: true; date: DateSpec }
  | { ok: false; reason: "invalid" };

export function normalizeDate(date: LlmAction["date"]): DateResult {
  switch (date.kind) {
    case "unspecified":
      return { ok: true, date: { kind: "unspecified" } };
    case "today":
      return { ok: true, date: { kind: "relative", days: 0 } };
    case "tomorrow":
      return { ok: true, date: { kind: "relative", days: 1 } };
    case "day_after_tomorrow":
      return { ok: true, date: { kind: "relative", days: 2 } };
    case "in_days": {
      const days = date.offsetDays;
      return days !== null && days >= 0 && days <= 366
        ? { ok: true, date: { kind: "relative", days } }
        : { ok: false, reason: "invalid" };
    }
    case "weekday":
      return date.weekday
        ? {
            ok: true,
            date: { kind: "weekday", weekday: WEEKDAYS.indexOf(date.weekday) },
          }
        : { ok: false, reason: "invalid" };
    case "calendar_date": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.isoDate ?? "");
      if (!match) return { ok: false, reason: "invalid" };
      const [year, month, day] = match.slice(1).map(Number);
      const probe = new Date(Date.UTC(year, month - 1, day));
      const real =
        probe.getUTCFullYear() === year &&
        probe.getUTCMonth() === month - 1 &&
        probe.getUTCDate() === day;
      return real
        ? { ok: true, date: { kind: "calendar_date", year, month, day } }
        : { ok: false, reason: "invalid" };
    }
  }
}

/**
 * Deterministic fix-ups the model gets wrong: "parson"/"परसों" (day after tomorrow) is
 * sometimes returned as tomorrow.
 */
export function correctDateFromText(date: LlmAction["date"], userText: string): LlmAction["date"] {
  if (/\bparso[n]?\b|परसों/i.test(userText) && (date.kind === "tomorrow" || date.kind === "unspecified")) {
    return { ...date, kind: "day_after_tomorrow" };
  }
  return date;
}

export function cleanReminderText(text: string | null): string | null {
  const cleaned = (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(to|for|about|ki|ke liye)\s+/i, "")
    .trim()
    .slice(0, 120);
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : null;
}
