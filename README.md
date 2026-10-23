# Nexis backend

Text-only chat API for the Nexis voice agent. Speech-to-text and text-to-speech run on the phone;
this server only ever receives the recognised text and returns a short reply from Groq, plus the
structured intent it understood (weather, reminder, alarm, calendar question or plain chat).

## Run

```bash
cp .env.example .env      # then set GROQ_API_KEY
npm install
npm run dev               # http://0.0.0.0:8787, restarts on change
npm test                  # offline tests (fake LLM, no key needed)
npm run smoke             # live check of the sample prompts against a running server (uses your Groq quota)
npm run build             # compile to dist/ (production)
npm start                 # run dist/server.js; reads .env if present, real env vars win
```

## Deploy on Render

Create a **Web Service** from the Git repo:

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Runtime | Node (version from `engines`: 22.9+ and below 25) |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

Environment variables: set `GROQ_API_KEY` (as a secret). Everything else has defaults; see
`.env.example`. Do not set `PORT` or `HOST`: Render provides `PORT` (default 10000) and the server
already binds `0.0.0.0`. `TRUST_PROXY` defaults to `1` on Render so rate limits apply per client,
not to Render's proxy.

Then point the app at the service: set `EXPO_PUBLIC_NEXIS_API_URL=https://<service>.onrender.com`
for the build (EAS env or `eas.json`), since `.env.local` is not uploaded.

Things to know:

- Free instances sleep after 15 minutes idle and take up to about a minute to wake; the app's
  20 s request timeout can expire on the first request after a sleep. Retry, or use a paid instance.
- Sessions live in memory, so a deploy, restart or sleep starts fresh conversations
  (`contextRestarted: true`). Use one instance; sessions are not shared between instances.
- On deploy, Render sends `SIGTERM`; the server stops accepting connections, lets in-flight replies
  finish for up to 20 s, then exits.

## `POST /chat`

Request (`Content-Type: application/json`, max 8 KB; any other content type, e.g. audio, gets 415):

```json
{
  "text": "Can you set a reminder for my meeting at 5 PM?",
  "sessionId": "0b6e3f0e-6a51-4c4a-9f63-2c7d7f6f2f10",
  "language": "auto",
  "resetContext": false,
  "context": { "timeZone": "Asia/Kolkata", "localDateTime": "2026-10-23T15:45" }
}
```

| Field          | Type                         | Notes                                                                                                                                                                                     |
| -------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`         | string, required             | Transcript, 1–1000 chars after trimming. Must contain letters or digits; control characters, data URIs and long base64 runs are rejected.                                                 |
| `sessionId`    | UUID, optional               | Omit on the first turn, then send back the one you receive.                                                                                                                               |
| `language`     | `en` \| `hinglish` \| `auto` | Default `auto`: mirrors the user (Devanagari or romanised Hindi → Hinglish).                                                                                                              |
| `resetContext` | boolean                      | Clears this session's history before answering.                                                                                                                                           |
| `context`      | object, optional             | The phone's IANA `timeZone` and wall-clock `localDateTime` (`YYYY-MM-DDTHH:mm`), so "kal", "parson" and "next Monday" are read in the user's zone. Without it the server's clock is used. |

Unknown fields are rejected.

Response `200`:

```json
{
  "sessionId": "0b6e3f0e-6a51-4c4a-9f63-2c7d7f6f2f10",
  "reply": {
    "text": "Please check the details and confirm.",
    "language": "en",
    "script": "latin"
  },
  "turn": 2,
  "contextRestarted": false,
  "model": "openai/gpt-oss-120b",
  "latencyMs": 910,
  "result": {
    "kind": "actions",
    "clarification": null,
    "weather": [],
    "device": [
      {
        "type": "set_reminder",
        "text": "Meeting",
        "when": {
          "date": { "kind": "unspecified" },
          "time": { "hour": 17, "minute": 0 }
        }
      }
    ]
  }
}
```

`contextRestarted: true` means the sent `sessionId` had expired (30 min idle) or the server restarted.

### `result`

| `kind`    | Meaning                                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`    | `reply.text` is a plain answer. `weather` and `device` are empty.                                                                                                                                                                                                                                   |
| `clarify` | `reply.text` is a question. `clarification.field` says what is missing: `location`, `location_not_found`, `location_ambiguous` (with `options`), `time`, `meridiem` (5 AM or 5 PM?), `reminder_text` or `date`. Send the user's answer as the next turn; the session context completes the request. |
| `actions` | `weather[]` holds real Open-Meteo forecasts that `reply.text` was templated from. `device[]` holds actions only the phone can perform.                                                                                                                                                              |

Device actions (`set_reminder`, `set_alarm`, `calendar_query`) carry a wall-clock time (`hour` 0–23, `minute`) and a date spec (`unspecified`, `relative` days, `weekday` 0–6 with 0 = Sunday, or `calendar_date`). The server never schedules anything or claims it did: the app resolves the instant in the phone's time zone (including DST gaps and overlaps), asks the user to confirm, performs the action with the platform API, and reports success only after the OS does. Calendar events are read and summarised on the phone and never sent here.

Weather: places are geocoded and forecast with [Open-Meteo](https://open-meteo.com/) (no key, up to 16 days ahead, non-commercial use). Every report carries `attribution` (`"Weather data by Open-Meteo.com"`, CC BY 4.0), which the app shows under the reply. If Open-Meteo is unreachable the reply says so; the server never makes up a forecast.

Errors always look like `{ "error": { "code", "message", "retryAfterSec"?, "details"? }, "requestId" }`:

| Status | `code`                   | When                                                                                                                              |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_INPUT`          | Schema or content checks failed; `details` lists fields.                                                                          |
| 401    | `UNAUTHORIZED`           | `CLIENT_API_KEY` is set and the header is missing or wrong.                                                                       |
| 404    | `NOT_FOUND`              | Any other route.                                                                                                                  |
| 409    | `SESSION_BUSY`           | A message in this session is still being answered.                                                                                |
| 413    | `PAYLOAD_TOO_LARGE`      | Body over 8 KB.                                                                                                                   |
| 415    | `UNSUPPORTED_MEDIA_TYPE` | Not JSON (audio, multipart, form).                                                                                                |
| 429    | `RATE_LIMITED`           | This client exceeded `RATE_LIMIT_PER_MINUTE`. `Retry-After` set.                                                                  |
| 429    | `UPSTREAM_RATE_LIMITED`  | Groq rate limit. `Retry-After` from Groq.                                                                                         |
| 502    | `UPSTREAM_ERROR`         | Groq rejected the request (bad server key, bad model), answered empty, or kept failing its own JSON-schema check after 2 retries. |
| 503    | `UPSTREAM_UNAVAILABLE`   | Groq 5xx/498 or unreachable. `Retry-After` set.                                                                                   |
| 504    | `UPSTREAM_TIMEOUT`       | Groq slower than `GROQ_TIMEOUT_MS`.                                                                                               |
| 500    | `INTERNAL`               | Bug.                                                                                                                              |

`GET /health` returns `{ ok, model, sessions }`.

## Notes

- Context is kept in memory (last `CONTEXT_MAX_MESSAGES` messages, LRU-capped). It is lost on restart and not shared between instances.
- Transcripts are not logged unless `LOG_USER_TEXT=true`.
- `CLIENT_API_KEY` only deters casual abuse; a key shipped inside an app is extractable.
- Intent extraction uses Groq strict structured outputs (`json_schema`, `strict: true`) and the result is validated again with Zod. Groq's free tier allows 8,000 tokens per minute and counts `MAX_COMPLETION_TOKENS` (900) against it, so rapid bursts can hit `UPSTREAM_RATE_LIMITED`.
