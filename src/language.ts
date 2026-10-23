export type ReplyLanguage = "en" | "hinglish";
export type RequestedLanguage = ReplyLanguage | "auto";
export type Script = "latin" | "devanagari" | "mixed" | "none";

const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-z]/g;

// Frequent romanised Hindi words that are rare as English words.
const ROMAN_HINDI = new Set([
  "hai",
  "hain",
  "nahi",
  "nahin",
  "kya",
  "kyun",
  "kyon",
  "kaise",
  "kaisa",
  "kab",
  "kahan",
  "kaun",
  "mujhe",
  "mujhko",
  "mera",
  "meri",
  "mere",
  "tera",
  "tum",
  "aap",
  "aapka",
  "aapki",
  "hum",
  "humko",
  "karo",
  "karna",
  "karde",
  "kar",
  "kardo",
  "raha",
  "rahi",
  "rahe",
  "tha",
  "thi",
  "hoga",
  "hogi",
  "batao",
  "bata",
  "bolo",
  "chahiye",
  "acha",
  "accha",
  "achha",
  "theek",
  "thik",
  "haan",
  "nahi",
  "bhai",
  "yaar",
  "abhi",
  "kal",
  "aaj",
  "kuch",
  "bahut",
  "zyada",
  "thoda",
  "sab",
  "wala",
  "wali",
  "ko",
  "ka",
  "ki",
  "ke",
  "se",
  "mein",
  "mai",
  "main",
  "aur",
  "lekin",
  "par",
  "phir",
  "matlab",
  "hoon",
  "hun",
  "ho",
  "gaya",
  "gayi",
  "diya",
  "liya",
  "dena",
  "lena",
  "jana",
  "jao",
  "chalo",
  "dila",
  "sakte",
  "sakta",
  "sakti",
  "yaad",
  "baje",
  "wahan",
  "yahan",
  "isko",
  "usko",
  "unko",
  "inko",
  "apna",
  "apni",
  "apne",
  "kitna",
  "kitne",
  "kaunsa",
  "subah",
  "shaam",
  "raat",
  "ghar",
  "khana",
  "paani",
  "dost",
]);
// Words in the set above that are also common in English text.
const AMBIGUOUS = new Set(["main", "par", "kal", "sab", "mai"]);

export function detectScript(text: string): Script {
  const devanagari = text.match(DEVANAGARI)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  if (!devanagari && !latin) return "none";
  if (!devanagari) return "latin";
  if (!latin) return "devanagari";
  return "mixed";
}

/** True when romanised Hindi words make up a meaningful share of the text. */
export function looksLikeRomanHindi(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return false;
  const hits = words.filter(
    (w) => ROMAN_HINDI.has(w) && !AMBIGUOUS.has(w),
  ).length;
  return hits >= 2 || (words.length <= 4 && hits >= 1);
}

export function detectLanguage(text: string): ReplyLanguage {
  const script = detectScript(text);
  if (script === "devanagari" || script === "mixed") return "hinglish";
  return looksLikeRomanHindi(text) ? "hinglish" : "en";
}

export function resolveReplyLanguage(
  requested: RequestedLanguage,
  userText: string,
): ReplyLanguage {
  return requested === "auto" ? detectLanguage(userText) : requested;
}
