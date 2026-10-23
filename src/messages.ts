import type { ReplyLanguage } from "./language.js";
import type { HinglishScript } from "./prompt.js";

type Variant = "en" | "dev" | "roman";
type Text = Record<Variant, string>;

export function variantOf(language: ReplyLanguage, script: HinglishScript): Variant {
  return language === "en" ? "en" : script === "devanagari" ? "dev" : "roman";
}

const pick = (t: Text, language: ReplyLanguage, script: HinglishScript) =>
  t[variantOf(language, script)];

export type ClarifyField =
  | "location"
  | "location_not_found"
  | "location_ambiguous"
  | "time"
  | "meridiem"
  | "reminder_text"
  | "date";

export interface ClarifyDetails {
  actionType: "weather" | "set_reminder" | "set_alarm";
  hour?: number;
  minute?: number;
  place?: string;
  options?: string[];
}

const hm = (hour = 0, minute = 0) => (minute ? `${hour}:${String(minute).padStart(2, "0")}` : `${hour}`);

/** One short question per missing or ambiguous detail. */
export function clarifyQuestion(
  field: ClarifyField,
  d: ClarifyDetails,
  language: ReplyLanguage,
  script: HinglishScript,
): string {
  const alarm = d.actionType === "set_alarm";
  const texts: Record<ClarifyField, Text> = {
    location: {
      en: "Which city should I check the weather for?",
      dev: "किस city का weather बताऊँ?",
      roman: "Kis city ka weather bataun?",
    },
    location_not_found: {
      en: `I couldn't find a place called "${d.place}". Which city do you mean?`,
      dev: `"${d.place}" नाम की जगह नहीं मिली। कौन सी city?`,
      roman: `"${d.place}" naam ki jagah nahi mili. Kaun si city?`,
    },
    location_ambiguous: {
      en: `I found more than one ${d.place}: ${(d.options ?? []).join("; ")}. Which one?`,
      dev: `${d.place} नाम की कई जगहें हैं: ${(d.options ?? []).join("; ")}। कौन सी?`,
      roman: `${d.place} naam ki kai jagah hain: ${(d.options ?? []).join("; ")}. Kaun si?`,
    },
    time: alarm
      ? {
          en: "What time should I set the alarm for?",
          dev: "Alarm किस time के लिए लगाऊँ?",
          roman: "Alarm kis time ke liye lagaun?",
        }
      : {
          en: "What time should I remind you?",
          dev: "Reminder किस time के लिए set करूँ?",
          roman: "Reminder kis time ke liye set karun?",
        },
    meridiem: {
      en: `Is that ${hm(d.hour, d.minute)} in the morning or the evening?`,
      dev: `${hm(d.hour, d.minute)} बजे सुबह या शाम?`,
      roman: `${hm(d.hour, d.minute)} baje subah ya shaam?`,
    },
    reminder_text: {
      en: "What should I remind you about?",
      dev: "किस बात के लिए reminder चाहिए?",
      roman: "Kis baat ke liye reminder chahiye?",
    },
    date: {
      en: "Which date do you mean?",
      dev: "कौन सी date?",
      roman: "Kaun si date?",
    },
  };
  return pick(texts[field], language, script);
}

/** Said while the phone asks for confirmation; never claims the action is done. */
export function confirmPrompt(language: ReplyLanguage, script: HinglishScript): string {
  return pick(
    {
      en: "Please check the details and confirm.",
      dev: "Details check करके confirm कीजिए।",
      roman: "Details check karke confirm kijiye.",
    },
    language,
    script,
  );
}

export function calendarPrompt(language: ReplyLanguage, script: HinglishScript): string {
  return pick(
    {
      en: "Checking the calendar on your phone.",
      dev: "आपके phone का calendar देख रहा हूँ।",
      roman: "Aapke phone ka calendar dekh raha hoon.",
    },
    language,
    script,
  );
}

export function weatherUnavailable(language: ReplyLanguage, script: HinglishScript): string {
  return pick(
    {
      en: "I couldn't reach the weather service, so I can't give a forecast right now. Please try again in a moment.",
      dev: "Weather service से connect नहीं हो पाया, इसलिए अभी forecast नहीं बता सकता। थोड़ी देर में फिर try कीजिए।",
      roman: "Weather service se connect nahi ho paya, isliye abhi forecast nahi bata sakta. Thodi der mein phir try kijiye.",
    },
    language,
    script,
  );
}

export function weatherOutOfRange(
  reason: "beyond_range" | "past",
  language: ReplyLanguage,
  script: HinglishScript,
): string {
  return reason === "past"
    ? pick(
        {
          en: "That date has already passed, so there is no forecast for it.",
          dev: "वो date निकल चुकी है, उसका forecast नहीं है।",
          roman: "Wo date nikal chuki hai, uska forecast nahi hai.",
        },
        language,
        script,
      )
    : pick(
        {
          en: "I can only get forecasts up to 16 days ahead.",
          dev: "मैं सिर्फ 16 दिन आगे तक का forecast बता सकता हूँ।",
          roman: "Main sirf 16 din aage tak ka forecast bata sakta hoon.",
        },
        language,
        script,
      );
}
