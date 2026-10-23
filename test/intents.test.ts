import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAssist } from "../src/assist.js";
import {
  cleanReminderText,
  correctDateFromText,
  LlmExtractionSchema,
  normalizeDate,
  normalizeTime,
  type LlmAction,
  type LlmExtraction,
} from "../src/intents.js";
import {
  chooseDay,
  choosePlace,
  formatWeather,
  WeatherUnavailableError,
  type DailyForecast,
  type GeoPlace,
  type WeatherProvider,
} from "../src/weather.js";

type Time = LlmAction["time"];
const t = (hour: number, minute = 0, meridiem: Time["meridiem"] = "none", partOfDay: Time["partOfDay"] = "none"): Time => ({
  said: true,
  hour,
  minute,
  meridiem,
  partOfDay,
});
const NO_TIME: Time = { said: false, hour: 0, minute: 0, meridiem: "none", partOfDay: "none" };
const NO_DATE: LlmAction["date"] = { kind: "unspecified", weekday: null, isoDate: null, offsetDays: null };

function action(partial: Partial<LlmAction> & Pick<LlmAction, "type">): LlmAction {
  return {
    location: null,
    date: NO_DATE,
    time: NO_TIME,
    reminderText: null,
    calendarRange: null,
    wantsNextEvent: false,
    ...partial,
  };
}

describe("normalizeTime", () => {
  const cases: [string, Time, number | string][] = [
    ["5 PM", t(5, 0, "pm"), 17],
    ["12 PM is noon", t(12, 0, "pm"), 12],
    ["12 AM is midnight", t(12, 0, "am"), 0],
    ["subah 7 baje", t(7, 0, "none", "morning"), 7],
    ["dopahar 1 baje", t(1, 0, "none", "afternoon"), 13],
    ["shaam 6:30", t(6, 30, "none", "evening"), 18],
    ["raat 10 baje", t(10, 0, "none", "night"), 22],
    ["raat 12 baje", t(12, 0, "none", "night"), 0],
    ["raat 2 baje", t(2, 0, "none", "night"), 2],
    ["17:45 (24-hour)", t(17, 45), 17],
    ["00:15 (24-hour)", t(0, 15), 0],
    ["24:00", t(24), 0],
    ["bare 9 is ambiguous", t(9), "ambiguous_meridiem"],
    ["no time said", NO_TIME, "missing"],
    ["minute 75 is invalid", t(5, 75, "pm"), "invalid"],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const result = normalizeTime(input);
      if (typeof expected === "number") {
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.time.hour, expected);
        assert.equal(result.time.minute, input.minute === 75 ? 0 : input.minute);
      } else {
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.reason, expected);
      }
    });
  }
});

describe("normalizeDate", () => {
  it("maps relative words", () => {
    assert.deepEqual(normalizeDate({ ...NO_DATE, kind: "tomorrow" }), { ok: true, date: { kind: "relative", days: 1 } });
    assert.deepEqual(normalizeDate({ ...NO_DATE, kind: "day_after_tomorrow" }), {
      ok: true,
      date: { kind: "relative", days: 2 },
    });
    assert.deepEqual(normalizeDate({ ...NO_DATE, kind: "in_days", offsetDays: 5 }), {
      ok: true,
      date: { kind: "relative", days: 5 },
    });
  });
  it("maps weekdays to 0 = Sunday", () => {
    assert.deepEqual(normalizeDate({ ...NO_DATE, kind: "weekday", weekday: "monday" }), {
      ok: true,
      date: { kind: "weekday", weekday: 1 },
    });
  });
  it("accepts real calendar dates and rejects impossible ones", () => {
    assert.deepEqual(normalizeDate({ ...NO_DATE, kind: "calendar_date", isoDate: "2026-11-03" }), {
      ok: true,
      date: { kind: "calendar_date", year: 2026, month: 11, day: 3 },
    });
    assert.equal(normalizeDate({ ...NO_DATE, kind: "calendar_date", isoDate: "2026-02-30" }).ok, false);
    assert.equal(normalizeDate({ ...NO_DATE, kind: "calendar_date", isoDate: "next week" }).ok, false);
    assert.equal(normalizeDate({ ...NO_DATE, kind: "in_days", offsetDays: null }).ok, false);
  });
  it('corrects "parson" mistaken for tomorrow', () => {
    assert.equal(correctDateFromText({ ...NO_DATE, kind: "tomorrow" }, "Parson Delhi mein baarish?").kind, "day_after_tomorrow");
    assert.equal(correctDateFromText({ ...NO_DATE, kind: "tomorrow" }, "परसों का weather").kind, "day_after_tomorrow");
    assert.equal(correctDateFromText({ ...NO_DATE, kind: "tomorrow" }, "Kal ka weather").kind, "tomorrow");
  });
  it("cleans reminder text", () => {
    assert.equal(cleanReminderText("  my   meeting "), "My meeting");
    assert.equal(cleanReminderText("to call mom"), "Call mom");
    assert.equal(cleanReminderText("   "), null);
  });
});

const place = (name: string, region: string | null, countryCode: string, population: number | null, featureCode = "PPL"): GeoPlace => ({
  name,
  region,
  country: countryCode === "IN" ? "India" : "United States",
  countryCode,
  latitude: 1,
  longitude: 2,
  timezone: "Asia/Kolkata",
  population,
  featureCode,
});

describe("choosePlace", () => {
  const springfields = [
    place("Springfield", "Missouri", "US", 170188),
    place("Springfield", "Illinois", "US", 114394),
    place("Springfield", "Massachusetts", "US", 154341),
  ];
  it("picks the only populated place", () => {
    assert.equal(choosePlace([place("Bengaluru", "Karnataka", "IN", 8495492)]).kind, "one");
  });
  it("asks when several places are similar in size", () => {
    const choice = choosePlace(springfields);
    assert.equal(choice.kind, "ambiguous");
  });
  it("uses the region the user named", () => {
    const choice = choosePlace(springfields, "Illinois");
    assert.equal(choice.kind === "one" && choice.place.region, "Illinois");
  });
  it("prefers a clearly dominant city", () => {
    const choice = choosePlace([place("Delhi", "Delhi", "IN", 10927986), place("Delhi", "Ontario", "US", 4000)]);
    assert.equal(choice.kind === "one" && choice.place.region, "Delhi");
  });
  it("ignores non-populated features and handles no match", () => {
    assert.equal(choosePlace([place("Bangalore Hill", null, "IN", null, "HLL")]).kind, "none");
    assert.equal(choosePlace([]).kind, "none");
  });
});

const forecast: DailyForecast = {
  dates: ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"],
  weatherCode: [80, 81, 95, 0],
  tempMax: [25.1, 26.9, 23.9, 28],
  tempMin: [19.9, 19.9, 19.6, 18],
  precipProbabilityMax: [78, 97, 78, null],
  precipSum: [4.9, 23.6, 31.3, 0],
  timezone: "Asia/Kolkata",
};

describe("chooseDay", () => {
  it("counts days in the place's own calendar", () => {
    assert.deepEqual(chooseDay(forecast, { kind: "unspecified" }), { ok: true, index: 0 });
    assert.deepEqual(chooseDay(forecast, { kind: "relative", days: 1 }), { ok: true, index: 1 });
    assert.deepEqual(chooseDay(forecast, { kind: "weekday", weekday: 0 }), { ok: true, index: 2 }); // 2026-10-25 is a Sunday
    assert.deepEqual(chooseDay(forecast, { kind: "calendar_date", year: 2026, month: 10, day: 26 }), { ok: true, index: 3 });
  });
  it("refuses days outside the forecast", () => {
    assert.deepEqual(chooseDay(forecast, { kind: "relative", days: 20 }), { ok: false, reason: "beyond_range" });
    assert.deepEqual(chooseDay(forecast, { kind: "calendar_date", year: 2026, month: 10, day: 1 }), { ok: false, reason: "past" });
  });
});

class FakeWeather implements WeatherProvider {
  searches: [string, string | null][] = [];
  constructor(
    private places: GeoPlace[],
    private fail = false,
  ) {}
  async searchPlaces(name: string, countryCode: string | null) {
    this.searches.push([name, countryCode]);
    if (this.fail) throw new WeatherUnavailableError("down");
    return this.places;
  }
  async dailyForecast() {
    if (this.fail) throw new WeatherUnavailableError("down");
    return forecast;
  }
}

const bengaluru = place("Bengaluru", "Karnataka", "IN", 8495492);
const run = (extraction: LlmExtraction, weather: WeatherProvider = new FakeWeather([bengaluru]), userText = "", language: "en" | "hinglish" = "en") =>
  runAssist(LlmExtractionSchema.parse(extraction), { userText, language, script: "devanagari", weather });

describe("runAssist — the four sample requests", () => {
  it('"What is the weather forecast for Bangalore tomorrow?" uses real provider data', async () => {
    const provider = new FakeWeather([bengaluru]);
    const out = await run(
      {
        actions: [action({ type: "weather", location: { name: "Bengaluru", region: null, countryCode: "IN" }, date: { ...NO_DATE, kind: "tomorrow" } })],
        reply: "",
      },
      provider,
    );
    assert.equal(out.kind, "actions");
    assert.deepEqual(provider.searches, [["Bengaluru", "IN"]]);
    assert.equal(out.weather[0].date, "2026-10-24");
    assert.equal(out.weather[0].condition, "moderate rain showers");
    assert.equal(out.replyText, "Tomorrow in Bengaluru, Karnataka: moderate rain showers, 20 to 27°C, with a 97% chance of rain.");
    assert.equal(out.weather[0].attribution.text, "Weather data by Open-Meteo.com");
  });

  it('"Can you set a reminder for my meeting at 5 PM?" becomes a device action to confirm', async () => {
    const out = await run({
      actions: [action({ type: "set_reminder", time: t(5, 0, "pm"), reminderText: "my meeting" })],
      reply: "",
    });
    assert.deepEqual(out.device, [
      { type: "set_reminder", text: "My meeting", when: { date: { kind: "unspecified" }, time: { hour: 17, minute: 0 } } },
    ]);
    assert.match(out.replyText, /confirm/);
    assert.doesNotMatch(out.replyText, /set|done|added/i);
  });

  it('"Mujhe kal subah 7 baje ka alarm set karna hai." is an alarm for tomorrow 07:00', async () => {
    const out = await run(
      {
        actions: [action({ type: "set_alarm", date: { ...NO_DATE, kind: "tomorrow" }, time: t(7, 0, "none", "morning") })],
        reply: "",
      },
      undefined,
      "Mujhe kal subah 7 baje ka alarm set karna hai.",
      "hinglish",
    );
    assert.deepEqual(out.device, [
      { type: "set_alarm", label: null, when: { date: { kind: "relative", days: 1 }, time: { hour: 7, minute: 0 } } },
    ]);
    assert.equal(out.replyText, "Details check करके confirm कीजिए।");
  });

  it('"Aaj ka schedule kya hai, aur meri next meeting kab hai?" is a calendar query for the phone', async () => {
    const out = await run({
      actions: [action({ type: "calendar_query", calendarRange: "today", wantsNextEvent: true })],
      reply: "",
    });
    assert.deepEqual(out.device, [{ type: "calendar_query", range: "today", wantsNextEvent: true }]);
  });
});

describe("runAssist — clarification and failures", () => {
  it("asks for a missing time, an unclear AM/PM and a missing description", async () => {
    let out = await run({ actions: [action({ type: "set_reminder", reminderText: "Call mom" })], reply: "" });
    assert.equal(out.kind, "clarify");
    assert.equal(out.replyText, "What time should I remind you?");
    out = await run({ actions: [action({ type: "set_reminder", reminderText: "Dentist", time: t(9) })], reply: "" });
    assert.equal(out.replyText, "Is that 9 in the morning or the evening?");
    out = await run({ actions: [action({ type: "set_reminder", time: t(6, 0, "pm") })], reply: "" });
    assert.equal(out.clarification?.field, "reminder_text");
    out = await run({ actions: [action({ type: "set_alarm" })], reply: "" });
    assert.equal(out.replyText, "What time should I set the alarm for?");
  });

  it("asks for a city when none was given and lists ambiguous ones", async () => {
    let out = await run({ actions: [action({ type: "weather" })], reply: "" });
    assert.equal(out.clarification?.field, "location");
    const springfield = new FakeWeather([
      place("Springfield", "Missouri", "US", 170188),
      place("Springfield", "Illinois", "US", 114394),
    ]);
    out = await run(
      { actions: [action({ type: "weather", location: { name: "Springfield", region: null, countryCode: null } })], reply: "" },
      springfield,
    );
    assert.equal(out.clarification?.field, "location_ambiguous");
    assert.match(out.replyText, /Missouri.*Illinois/);
  });

  it("never fabricates a forecast when the provider is down", async () => {
    const out = await run(
      { actions: [action({ type: "weather", location: { name: "Bengaluru", region: null, countryCode: "IN" } })], reply: "It is sunny and 30 degrees." },
      new FakeWeather([], true),
    );
    assert.equal(out.weather.length, 0);
    assert.match(out.replyText, /couldn't reach the weather service/);
    assert.doesNotMatch(out.replyText, /sunny|30/);
  });

  it("says when a date is beyond the 16-day forecast", async () => {
    const out = await run({
      actions: [action({ type: "weather", location: { name: "Bengaluru", region: null, countryCode: "IN" }, date: { ...NO_DATE, kind: "in_days", offsetDays: 30 } })],
      reply: "",
    });
    assert.equal(out.weather.length, 0);
    assert.match(out.replyText, /16 days/);
  });

  it("passes chat answers through", async () => {
    const out = await run({ actions: [action({ type: "chat" })], reply: "The capital of Karnataka is Bengaluru." });
    assert.equal(out.kind, "chat");
    assert.equal(out.replyText, "The capital of Karnataka is Bengaluru.");
  });
});

describe("formatWeather", () => {
  const report = {
    place: { name: "Bengaluru", region: "Karnataka", country: "India", countryCode: "IN", latitude: 1, longitude: 2, timezone: "Asia/Kolkata" },
    date: "2026-10-25",
    dayOffset: 2,
    weatherCode: 95,
    condition: "thunderstorm",
    tempMaxC: 23.9,
    tempMinC: 19.6,
    precipitationProbabilityMax: 78,
    precipitationSumMm: 31.3,
    attribution: { source: "Open-Meteo", text: "Weather data by Open-Meteo.com", url: "https://open-meteo.com/" },
  } as const;
  it("renders English, Devanagari Hinglish and Roman Hinglish from the same numbers", () => {
    assert.equal(formatWeather(report, "en", "devanagari"), "On Sunday, 25 October in Bengaluru, Karnataka: thunderstorm, 20 to 24°C, with a 78% chance of rain.");
    assert.equal(formatWeather(report, "hinglish", "devanagari"), "परसों Bengaluru, Karnataka में thunderstorm रहेगा, temperature 20 से 24°C, बारिश का chance 78% है।");
    assert.equal(formatWeather(report, "hinglish", "roman"), "Parson Bengaluru, Karnataka mein thunderstorm rahega, temperature 20 se 24°C, baarish ka chance 78% hai.");
  });
});
