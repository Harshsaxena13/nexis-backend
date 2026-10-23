// Live check against a running server (real Groq + Open-Meteo). Usage: npm run smoke [-- http://host:8787]
const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.CLIENT_API_KEY)
  headers["x-nexis-client-key"] = process.env.CLIENT_API_KEY;

// Groq's free tier allows 8,000 tokens/minute and reserves max_completion_tokens per call.
const GAP_MS = 9000;

const pad = (n: number) => String(n).padStart(2, "0");
const now = new Date();
const context = {
  timeZone: "Asia/Kolkata",
  localDateTime: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`,
};

// Each sample starts its own session; a follow-up answers the previous turn's question.
const samples: { text: string; followUp?: string }[] = [
  { text: "What is the weather forecast for Bangalore tomorrow?" },
  { text: "Can you set a reminder for my meeting at 5 PM?" },
  { text: "Mujhe kal subah 7 baje ka alarm set karna hai." },
  { text: "Aaj ka schedule kya hai, aur meri next meeting kab hai?" },
  { text: "Remind me to call Mom tomorrow at 6", followUp: "PM" },
];

async function send(text: string, sessionId?: string) {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, sessionId, language: "auto", context }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`✗ ${res.status}`, body);
    process.exit(1);
  }
  const { kind, clarification, weather, device } = body.result;
  console.log(`\n> ${text}`);
  console.log(`< [${kind}, ${body.reply.language}/${body.reply.script}, ${body.latencyMs} ms] ${body.reply.text}`);
  if (clarification) console.log(`  clarify: ${clarification.field}`);
  for (const w of weather) console.log(`  weather: ${w.place.name}, ${w.place.region} ${w.date} — ${w.attribution.text}`);
  for (const d of device) console.log(`  device: ${JSON.stringify(d)}`);
  return body.sessionId as string;
}

const pause = () => new Promise((r) => setTimeout(r, GAP_MS));
for (const [i, sample] of samples.entries()) {
  if (i > 0) await pause();
  const sessionId = await send(sample.text);
  if (sample.followUp) {
    await pause();
    await send(sample.followUp, sessionId);
  }
}
console.log(`\n✓ ${samples.length} samples`);
