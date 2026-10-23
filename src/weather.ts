import type { DateSpec } from "./intents.js";
import type { ReplyLanguage } from "./language.js";
import type { HinglishScript } from "./prompt.js";

/** Open-Meteo data is CC BY 4.0: show this credit wherever the data appears. */
export const WEATHER_ATTRIBUTION = {
  source: "Open-Meteo",
  text: "Weather data by Open-Meteo.com",
  url: "https://open-meteo.com/",
} as const;

export const MAX_FORECAST_DAYS = 16;

export interface GeoPlace {
  name: string;
  region: string | null;
  country: string | null;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone: string;
  population: number | null;
  featureCode: string | null;
}

export interface DailyForecast {
  /** Local dates (YYYY-MM-DD) in the place's time zone; index 0 is today there. */
  dates: string[];
  weatherCode: number[];
  tempMax: number[];
  tempMin: number[];
  precipProbabilityMax: (number | null)[];
  precipSum: number[];
  timezone: string;
}

export interface WeatherProvider {
  searchPlaces(name: string, countryCode: string | null): Promise<GeoPlace[]>;
  dailyForecast(latitude: number, longitude: number): Promise<DailyForecast>;
}

export class WeatherUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "WeatherUnavailableError";
  }
}

const TIMEOUT_MS = 6000;

async function getJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new WeatherUnavailableError("Weather service unreachable", error);
  }
  if (!response.ok) {
    throw new WeatherUnavailableError(`Weather service answered ${response.status}`);
  }
  return response.json();
}

export class OpenMeteoProvider implements WeatherProvider {
  async searchPlaces(name: string, countryCode: string | null): Promise<GeoPlace[]> {
    const params = new URLSearchParams({ name, count: "10", language: "en", format: "json" });
    if (countryCode) params.set("countryCode", countryCode.toUpperCase());
    const body = (await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?${params}`,
    )) as { results?: Record<string, unknown>[] };
    return (body.results ?? []).map((r) => ({
      name: String(r.name),
      region: typeof r.admin1 === "string" ? r.admin1 : null,
      country: typeof r.country === "string" ? r.country : null,
      countryCode: String(r.country_code ?? ""),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      timezone: String(r.timezone ?? "auto"),
      population: typeof r.population === "number" ? r.population : null,
      featureCode: typeof r.feature_code === "string" ? r.feature_code : null,
    }));
  }

  async dailyForecast(latitude: number, longitude: number): Promise<DailyForecast> {
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
      timezone: "auto",
      forecast_days: String(MAX_FORECAST_DAYS),
    });
    const body = (await getJson(`https://api.open-meteo.com/v1/forecast?${params}`)) as {
      timezone?: string;
      daily?: Record<string, unknown[]>;
    };
    const d = body.daily;
    if (!d || !Array.isArray(d.time) || d.time.length === 0) {
      throw new WeatherUnavailableError("Weather service returned no daily data");
    }
    return {
      dates: d.time.map(String),
      weatherCode: (d.weather_code ?? []).map(Number),
      tempMax: (d.temperature_2m_max ?? []).map(Number),
      tempMin: (d.temperature_2m_min ?? []).map(Number),
      precipProbabilityMax: (d.precipitation_probability_max ?? []).map((v) =>
        v === null || v === undefined ? null : Number(v),
      ),
      precipSum: (d.precipitation_sum ?? []).map(Number),
      timezone: body.timezone ?? "GMT",
    };
  }
}

export type PlaceChoice =
  | { kind: "one"; place: GeoPlace }
  | { kind: "ambiguous"; options: GeoPlace[] }
  | { kind: "none" };

/**
 * Picks a populated place. A clearly dominant result (5x the population of the next) wins;
 * otherwise the user is asked, e.g. "Springfield" in Missouri, Illinois or Massachusetts.
 */
export function choosePlace(results: GeoPlace[], region: string | null = null): PlaceChoice {
  let places = results.filter((p) => !p.featureCode || p.featureCode.startsWith("PPL"));
  if (region) {
    const want = region.trim().toLowerCase();
    const inRegion = places.filter((p) =>
      [p.region, p.country, p.countryCode].some((v) => {
        const have = v?.toLowerCase();
        return !!have && (have === want || have.includes(want) || want.includes(have));
      }),
    );
    // A region that matches nothing is ignored rather than hiding every result.
    if (inRegion.length > 0) places = inRegion;
  }
  if (places.length === 0) return { kind: "none" };
  if (places.length === 1) return { kind: "one", place: places[0] };
  const sorted = [...places].sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  const [first, second] = sorted;
  if ((first.population ?? 0) >= 5 * Math.max(1, second.population ?? 0)) {
    return { kind: "one", place: first };
  }
  return { kind: "ambiguous", options: sorted.slice(0, 3) };
}

export type DayChoice =
  | { ok: true; index: number }
  | { ok: false; reason: "beyond_range" | "past" };

const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** Finds the forecast day for a DateSpec, counting "today" in the place's own time zone. */
export function chooseDay(forecast: DailyForecast, spec: DateSpec): DayChoice {
  const { dates } = forecast;
  switch (spec.kind) {
    case "unspecified":
      return { ok: true, index: 0 };
    case "relative":
      return spec.days < dates.length
        ? { ok: true, index: spec.days }
        : { ok: false, reason: "beyond_range" };
    case "weekday": {
      const index = dates.findIndex((d) => weekdayOf(d) === spec.weekday);
      return index >= 0 ? { ok: true, index } : { ok: false, reason: "beyond_range" };
    }
    case "calendar_date": {
      const iso = `${spec.year}-${String(spec.month).padStart(2, "0")}-${String(spec.day).padStart(2, "0")}`;
      const index = dates.indexOf(iso);
      if (index >= 0) return { ok: true, index };
      return iso < dates[0] ? { ok: false, reason: "past" } : { ok: false, reason: "beyond_range" };
    }
  }
}

/** WMO weather interpretation codes, as listed in the Open-Meteo docs. */
const WMO: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snowfall",
  73: "moderate snowfall",
  75: "heavy snowfall",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  97: "heavy thunderstorm",
  99: "thunderstorm with heavy hail",
};

export const describeWeatherCode = (code: number) => WMO[code] ?? "mixed conditions";

export interface WeatherReport {
  place: {
    name: string;
    region: string | null;
    country: string | null;
    countryCode: string;
    latitude: number;
    longitude: number;
    timezone: string;
  };
  /** Local date at the place (YYYY-MM-DD) and days after the place's today. */
  date: string;
  dayOffset: number;
  weatherCode: number;
  condition: string;
  tempMaxC: number;
  tempMinC: number;
  precipitationProbabilityMax: number | null;
  precipitationSumMm: number;
  attribution: typeof WEATHER_ATTRIBUTION;
}

export function buildReport(place: GeoPlace, forecast: DailyForecast, index: number): WeatherReport {
  return {
    place: {
      name: place.name,
      region: place.region,
      country: place.country,
      countryCode: place.countryCode,
      latitude: place.latitude,
      longitude: place.longitude,
      timezone: forecast.timezone,
    },
    date: forecast.dates[index],
    dayOffset: index,
    weatherCode: forecast.weatherCode[index],
    condition: describeWeatherCode(forecast.weatherCode[index]),
    tempMaxC: forecast.tempMax[index],
    tempMinC: forecast.tempMin[index],
    precipitationProbabilityMax: forecast.precipProbabilityMax[index] ?? null,
    precipitationSumMm: forecast.precipSum[index] ?? 0,
    attribution: WEATHER_ATTRIBUTION,
  };
}

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function dayLabel(report: WeatherReport, language: ReplyLanguage, script: HinglishScript): string {
  const [, month, day] = report.date.split("-").map(Number);
  const named = `${EN_WEEKDAYS[weekdayOf(report.date)]}, ${day} ${EN_MONTHS[month - 1]}`;
  if (language === "en") {
    return report.dayOffset === 0 ? "Today" : report.dayOffset === 1 ? "Tomorrow" : `On ${named}`;
  }
  if (script === "devanagari") {
    return ["आज", "कल", "परसों"][report.dayOffset] ?? `${named} को`;
  }
  return ["Aaj", "Kal", "Parson"][report.dayOffset] ?? `${named} ko`;
}

export function placeLabel(place: { name: string; region: string | null; country: string | null }): string {
  const extra = place.region && place.region !== place.name ? place.region : place.country;
  return extra ? `${place.name}, ${extra}` : place.name;
}

/** Spoken forecast built only from the provider's numbers. */
export function formatWeather(report: WeatherReport, language: ReplyLanguage, script: HinglishScript): string {
  const day = dayLabel(report, language, script);
  const where = placeLabel(report.place);
  const lo = Math.round(report.tempMinC);
  const hi = Math.round(report.tempMaxC);
  const p = report.precipitationProbabilityMax;
  if (language === "en") {
    const rain = p === null ? "" : `, with a ${p}% chance of rain`;
    return `${day} in ${where}: ${report.condition}, ${lo} to ${hi}°C${rain}.`;
  }
  if (script === "devanagari") {
    const rain = p === null ? "" : `, बारिश का chance ${p}% है`;
    return `${day} ${where} में ${report.condition} रहेगा, temperature ${lo} से ${hi}°C${rain}।`;
  }
  const rain = p === null ? "" : `, baarish ka chance ${p}% hai`;
  return `${day} ${where} mein ${report.condition} rahega, temperature ${lo} se ${hi}°C${rain}.`;
}
