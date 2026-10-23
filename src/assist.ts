import {
  cleanReminderText,
  correctDateFromText,
  normalizeDate,
  normalizeTime,
  type Clock24,
  type DateSpec,
  type LlmAction,
  type LlmExtraction,
} from "./intents.js";
import type { ReplyLanguage } from "./language.js";
import {
  calendarPrompt,
  clarifyQuestion,
  confirmPrompt,
  weatherOutOfRange,
  weatherUnavailable,
  type ClarifyDetails,
  type ClarifyField,
} from "./messages.js";
import type { HinglishScript } from "./prompt.js";
import {
  buildReport,
  chooseDay,
  choosePlace,
  formatWeather,
  placeLabel,
  WeatherUnavailableError,
  type WeatherProvider,
  type WeatherReport,
} from "./weather.js";

/** Actions the phone performs itself (permissions, scheduling, calendar access). */
export type DeviceAction =
  | { type: "set_reminder"; text: string; when: { date: DateSpec; time: Clock24 } }
  | { type: "set_alarm"; label: string | null; when: { date: DateSpec; time: Clock24 } }
  | {
      type: "calendar_query";
      range: "today" | "tomorrow" | "this_week";
      wantsNextEvent: boolean;
    };

export interface Clarification extends ClarifyDetails {
  field: ClarifyField;
}

export interface AssistOutcome {
  kind: "chat" | "clarify" | "actions";
  replyText: string;
  clarification: Clarification | null;
  weather: WeatherReport[];
  device: DeviceAction[];
}

interface AssistOptions {
  /** The user's message, for deterministic corrections of the extraction. */
  userText: string;
  language: ReplyLanguage;
  script: HinglishScript;
  weather: WeatherProvider;
}

type Checked =
  | {
      ok: true;
      device?: DeviceAction;
      weather?: { name: string; region: string | null; countryCode: string | null; date: DateSpec };
    }
  | { ok: false; clarification: Clarification };

/** Validates one extracted action; anything missing or ambiguous becomes a question. */
function check(raw: LlmAction, userText: string): Checked {
  const action = { ...raw, date: correctDateFromText(raw.date, userText) };
  const ask = (field: ClarifyField, d: ClarifyDetails): Checked => ({
    ok: false,
    clarification: { field, ...d },
  });

  switch (action.type) {
    case "weather": {
      if (!action.location?.name.trim()) return ask("location", { actionType: "weather" });
      const date = normalizeDate(action.date);
      if (!date.ok) return ask("date", { actionType: "weather" });
      return {
        ok: true,
        weather: {
          name: action.location.name.trim(),
          region: action.location.region?.trim() || null,
          countryCode: action.location.countryCode,
          date: date.date,
        },
      };
    }
    case "set_reminder":
    case "set_alarm": {
      const actionType = action.type;
      const time = normalizeTime(action.time);
      if (!time.ok) {
        return time.reason === "ambiguous_meridiem"
          ? ask("meridiem", { actionType, hour: time.hour, minute: time.minute })
          : ask("time", { actionType });
      }
      const date = normalizeDate(action.date);
      if (!date.ok) return ask("date", { actionType });
      const when = { date: date.date, time: time.time };
      const text = cleanReminderText(action.reminderText);
      if (actionType === "set_alarm") {
        return { ok: true, device: { type: "set_alarm", label: text, when } };
      }
      if (!text) return ask("reminder_text", { actionType });
      return { ok: true, device: { type: "set_reminder", text, when } };
    }
    case "calendar_query":
      return {
        ok: true,
        device: {
          type: "calendar_query",
          range: action.calendarRange ?? "today",
          wantsNextEvent: action.wantsNextEvent,
        },
      };
    case "chat":
      return { ok: true };
  }
}

export async function runAssist(extraction: LlmExtraction, options: AssistOptions): Promise<AssistOutcome> {
  const { language, script } = options;
  const clarify = (clarification: Clarification): AssistOutcome => ({
    kind: "clarify",
    replyText: clarifyQuestion(clarification.field, clarification, language, script),
    clarification,
    weather: [],
    device: [],
  });

  // 1. Ask before doing anything if a detail is missing or ambiguous.
  const checked: { action: LlmAction; result: Extract<Checked, { ok: true }> }[] = [];
  for (const action of extraction.actions) {
    const result = check(action, options.userText);
    if (!result.ok) return clarify(result.clarification);
    checked.push({ action, result });
  }

  // 2. Weather is looked up here; device actions go back to the phone.
  const parts: string[] = [];
  const weather: WeatherReport[] = [];
  const device: DeviceAction[] = [];
  let hasChat = false;

  for (const { action, result } of checked) {
    if (action.type === "chat") {
      hasChat = true;
      if (extraction.reply.trim()) parts.push(extraction.reply.trim());
      continue;
    }
    if (result.device) {
      device.push(result.device);
      continue;
    }
    if (result.weather) {
      const { name, region, countryCode, date } = result.weather;
      try {
        let places = await options.weather.searchPlaces(name, countryCode);
        if (places.length === 0 && countryCode) places = await options.weather.searchPlaces(name, null);
        const choice = choosePlace(places, region);
        if (choice.kind === "none") return clarify({ field: "location_not_found", actionType: "weather", place: name });
        if (choice.kind === "ambiguous") {
          return clarify({
            field: "location_ambiguous",
            actionType: "weather",
            place: name.split(",")[0],
            options: choice.options.map((p) => placeLabel(p) + (p.country && p.region ? `, ${p.countryCode}` : "")),
          });
        }
        const forecast = await options.weather.dailyForecast(choice.place.latitude, choice.place.longitude);
        const day = chooseDay(forecast, date);
        if (!day.ok) {
          parts.push(weatherOutOfRange(day.reason, language, script));
          continue;
        }
        const report = buildReport(choice.place, forecast, day.index);
        weather.push(report);
        parts.push(formatWeather(report, language, script));
      } catch (error) {
        if (!(error instanceof WeatherUnavailableError)) throw error;
        parts.push(weatherUnavailable(language, script));
      }
    }
  }

  if (device.some((d) => d.type !== "calendar_query")) parts.push(confirmPrompt(language, script));
  else if (device.length > 0) parts.push(calendarPrompt(language, script));

  return {
    kind: hasChat && weather.length === 0 && device.length === 0 ? "chat" : "actions",
    replyText: parts.join(" "),
    clarification: null,
    weather,
    device,
  };
}
