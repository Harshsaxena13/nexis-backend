import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "groq-sdk";
import request from "supertest";

import { createApp, type AppConfig } from "../src/app.js";
import type { LlmClient, LlmMessage } from "../src/llm.js";

const baseConfig: AppConfig = {
  GROQ_MODEL: "test-model",
  MAX_REPLY_CHARS: 500,
  HINGLISH_SCRIPT: "devanagari",
  RATE_LIMIT_PER_MINUTE: 100,
  CONTEXT_MAX_MESSAGES: 12,
  SESSION_TTL_MINUTES: 30,
  MAX_SESSIONS: 100,
  CLIENT_API_KEY: undefined,
  TRUST_PROXY: undefined,
  LOG_USER_TEXT: "false",
};

/** Records every prompt and answers from a queue (or echoes). */
class FakeLlm implements LlmClient {
  calls: LlmMessage[][] = [];
  replies: (string | Error | (() => Promise<string>))[] = [];

  async complete(messages: LlmMessage[]) {
    this.calls.push(messages);
    const next =
      this.replies.shift() ?? `echo: ${messages[messages.length - 1].content}`;
    if (next instanceof Error) throw next;
    const text = typeof next === "function" ? await next() : next;
    return { text, model: "test-model" };
  }
}

function setup(overrides: Partial<AppConfig> = {}) {
  const llm = new FakeLlm();
  const { app } = createApp({
    config: { ...baseConfig, ...overrides },
    llm,
    log: () => {},
  });
  const chat = (body: unknown) =>
    request(app)
      .post("/chat")
      .send(body as object);
  return { app, llm, chat };
}

const groqError = (status: number, headers: Record<string, string> = {}) =>
  APIError.generate(
    status,
    { error: { message: "x" } },
    "x",
    new Headers(headers),
  );

describe("POST /chat — happy path and context", () => {
  it("answers and returns the contract fields", async () => {
    const { chat, llm } = setup();
    llm.replies.push("Your meeting is at 4 PM.");
    const res = await chat({ text: "When is my meeting?" });
    assert.equal(res.status, 200);
    assert.match(res.body.sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(res.body.reply, {
      text: "Your meeting is at 4 PM.",
      language: "en",
      script: "latin",
    });
    assert.equal(res.body.turn, 1);
    assert.equal(res.body.contextRestarted, false);
    assert.equal(res.body.model, "test-model");
    assert.equal(typeof res.body.latencyMs, "number");
    assert.ok(res.headers["x-request-id"]);
    assert.equal(llm.calls[0][0].role, "system");
    assert.deepEqual(llm.calls[0].at(-1), {
      role: "user",
      content: "When is my meeting?",
    });
  });

  it("keeps conversation context across turns", async () => {
    const { chat, llm } = setup();
    llm.replies.push("It is at 4 PM.", "It is in room 2.");
    const first = await chat({ text: "When is my meeting?" });
    const second = await chat({
      text: "Where is it?",
      sessionId: first.body.sessionId,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.turn, 2);
    assert.deepEqual(
      llm.calls[1]
        .filter((m) => m.role !== "system")
        .map((m) => [m.role, m.content]),
      [
        ["user", "When is my meeting?"],
        ["assistant", "It is at 4 PM."],
        ["user", "Where is it?"],
      ],
    );
  });

  it("restates the reply language right before the user message, without storing it", async () => {
    const { chat, llm } = setup();
    const first = await chat({ text: "Hello there" });
    await chat({
      text: "kal subah yaad dila dena",
      sessionId: first.body.sessionId,
    });
    const call = llm.calls[1];
    assert.equal(call.at(-2)?.role, "system");
    assert.match(call.at(-2)?.content ?? "", /Hinglish/);
    assert.match(llm.calls[0].at(-2)?.content ?? "", /English/);
    // History holds only the first exchange: the first turn's note was not stored.
    assert.equal(call.filter((m) => m.role === "system").length, 2);
  });

  it("resetContext clears history", async () => {
    const { chat, llm } = setup();
    const first = await chat({ text: "Remember the number seven." });
    await chat({
      text: "Forget it.",
      sessionId: first.body.sessionId,
      resetContext: true,
    });
    // Only the new user message besides system messages.
    assert.equal(llm.calls[1].filter((m) => m.role !== "system").length, 1);
  });

  it("starts a fresh context for an unknown sessionId and says so", async () => {
    const { chat } = setup();
    const id = "0b6e3f0e-6a51-4c4a-9f63-2c7d7f6f2f10";
    const res = await chat({ text: "Hello again", sessionId: id });
    assert.equal(res.status, 200);
    assert.equal(res.body.sessionId, id);
    assert.equal(res.body.contextRestarted, true);
  });

  it("auto-detects Hinglish from Devanagari and from romanised Hindi", async () => {
    const { chat, llm } = setup();
    llm.replies.push("ठीक है, meeting 4 बजे है।", "Haan, meeting 4 baje hai.");
    const dev = await chat({ text: "मेरी meeting कब है?" });
    const roman = await chat({ text: "meri meeting kab hai batao" });
    assert.equal(dev.body.reply.language, "hinglish");
    assert.equal(dev.body.reply.script, "mixed");
    assert.equal(roman.body.reply.language, "hinglish");
    assert.match(llm.calls[0][0].content, /Hinglish/);
    assert.match(llm.calls[0][0].content, /Devanagari/);
  });

  it("honours an explicit language over detection", async () => {
    const { chat, llm } = setup();
    const res = await chat({ text: "meri meeting kab hai", language: "en" });
    assert.equal(res.body.reply.language, "en");
    assert.doesNotMatch(llm.calls[0][0].content, /Hinglish/);
  });

  it("uses roman-script Hinglish when configured", async () => {
    const { chat, llm } = setup({ HINGLISH_SCRIPT: "roman" });
    await chat({ text: "kya haal hai", language: "hinglish" });
    assert.match(llm.calls[0][0].content, /entirely in Latin script/);
  });

  it("strips markdown and caps reply length", async () => {
    const { chat, llm } = setup({ MAX_REPLY_CHARS: 100 });
    llm.replies.push(
      `**Sure!** Here: [link](https://x.y). ${"Long sentence here. ".repeat(20)}`,
    );
    const res = await chat({ text: "Tell me" });
    assert.ok(res.body.reply.text.length <= 101);
    assert.doesNotMatch(res.body.reply.text, /[*[\]]|https?:/);
  });
});

describe("POST /chat — input validation (text only)", () => {
  const cases: [string, unknown, RegExp][] = [
    ["missing text", {}, /text/],
    ["empty text", { text: "   " }, /empty/],
    ["too long", { text: "a ".repeat(600) }, /longer than 1000/],
    ["non-string text", { text: 42 }, /string/],
    [
      "unknown field (audio)",
      { text: "hi", audio: "UklGRiQAAABXQVZF" },
      /audio|Unrecognized/i,
    ],
    ["base64 blob", { text: "UklGR".repeat(40) }, /encoded binary/],
    ["data URI", { text: "data:audio/wav;base64,UklGRiQ=" }, /encoded binary/],
    ["control characters", { text: "hi\u0000there" }, /control characters/],
    ["no letters", { text: "!!! ???" }, /no letters/],
    ["bad sessionId", { text: "hi", sessionId: "abc" }, /UUID/],
    ["bad language", { text: "hi", language: "fr" }, /language/],
  ];
  for (const [name, body, pattern] of cases) {
    it(`rejects ${name}`, async () => {
      const { chat, llm } = setup();
      const res = await chat(body);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INVALID_INPUT");
      assert.match(JSON.stringify(res.body.error.details), pattern);
      assert.equal(llm.calls.length, 0);
    });
  }

  it("rejects audio and multipart uploads with 415", async () => {
    const { app } = setup();
    const wav = await request(app)
      .post("/chat")
      .set("Content-Type", "audio/wav")
      .send(Buffer.from("RIFF....WAVE"));
    assert.equal(wav.status, 415);
    assert.equal(wav.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
    const multipart = await request(app)
      .post("/chat")
      .attach("file", Buffer.from("RIFF"), "a.wav");
    assert.equal(multipart.status, 415);
  });

  it("rejects oversized bodies with 413", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/chat")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ text: "x", pad: "y".repeat(20_000) }));
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "PAYLOAD_TOO_LARGE");
  });

  it("rejects malformed JSON", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/chat")
      .set("Content-Type", "application/json")
      .send('{"text":');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_INPUT");
  });
});

describe("POST /chat — rate limits and provider errors", () => {
  it("rate-limits per client with Retry-After", async () => {
    const { chat } = setup({ RATE_LIMIT_PER_MINUTE: 2 });
    assert.equal((await chat({ text: "one" })).status, 200);
    assert.equal((await chat({ text: "two" })).status, 200);
    const third = await chat({ text: "three" });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, "RATE_LIMITED");
    assert.ok(Number(third.headers["retry-after"]) >= 1);
  });

  const upstreamCases: [
    string,
    () => Error,
    number,
    string,
    number | undefined,
  ][] = [
    [
      "Groq 429",
      () => groqError(429, { "retry-after": "7" }),
      429,
      "UPSTREAM_RATE_LIMITED",
      7,
    ],
    ["Groq 500", () => groqError(500), 503, "UPSTREAM_UNAVAILABLE", 5],
    [
      "Groq 503",
      () => groqError(503, { "retry-after": "3" }),
      503,
      "UPSTREAM_UNAVAILABLE",
      3,
    ],
    [
      "Groq 401 (bad server key)",
      () => groqError(401),
      502,
      "UPSTREAM_ERROR",
      undefined,
    ],
    ["Groq 400", () => groqError(400), 502, "UPSTREAM_ERROR", undefined],
    [
      "timeout",
      () => new APIConnectionTimeoutError(),
      504,
      "UPSTREAM_TIMEOUT",
      undefined,
    ],
    [
      "network failure",
      () => new APIConnectionError({ message: "ECONNRESET" }),
      503,
      "UPSTREAM_UNAVAILABLE",
      5,
    ],
  ];
  for (const [name, makeError, status, code, retryAfter] of upstreamCases) {
    it(`maps ${name} to ${status} ${code}`, async () => {
      const { chat, llm } = setup();
      llm.replies.push(makeError());
      const res = await chat({ text: "hello" });
      assert.equal(res.status, status);
      assert.equal(res.body.error.code, code);
      assert.equal(res.body.error.retryAfterSec, retryAfter);
      if (retryAfter !== undefined)
        assert.equal(res.headers["retry-after"], String(retryAfter));
      assert.doesNotMatch(JSON.stringify(res.body), /gsk_|api[_-]?key/i);
    });
  }

  it("does not store a failed turn in context", async () => {
    const { chat, llm } = setup();
    const first = await chat({ text: "first" });
    llm.replies.push(groqError(500));
    await chat({ text: "lost", sessionId: first.body.sessionId });
    await chat({ text: "third", sessionId: first.body.sessionId });
    const contents = llm.calls[2].map((m) => m.content);
    assert.ok(!contents.includes("lost"));
  });

  it("returns 502 for an empty model answer", async () => {
    const { chat, llm } = setup();
    llm.replies.push("   ");
    const res = await chat({ text: "hello" });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, "UPSTREAM_ERROR");
  });

  it("refuses a second concurrent message in the same session", async () => {
    const { chat, llm } = setup();
    const first = await chat({ text: "start" });
    let release!: () => void;
    llm.replies.push(
      () =>
        new Promise<string>(
          (resolve) => (release = () => resolve("slow answer")),
        ),
    );
    const slow = chat({ text: "slow", sessionId: first.body.sessionId }).then(
      (r) => r,
    );
    await new Promise((r) => setTimeout(r, 20));
    const busy = await chat({ text: "fast", sessionId: first.body.sessionId });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, "SESSION_BUSY");
    release();
    assert.equal((await slow).status, 200);
  });
});

describe("other routes and client key", () => {
  it("requires the client key when configured", async () => {
    const { app } = setup({ CLIENT_API_KEY: "k".repeat(24) });
    const missing = await request(app).post("/chat").send({ text: "hi" });
    assert.equal(missing.status, 401);
    const ok = await request(app)
      .post("/chat")
      .set("x-nexis-client-key", "k".repeat(24))
      .send({ text: "hi" });
    assert.equal(ok.status, 200);
  });

  it("serves /health and 404s elsewhere", async () => {
    const { app } = setup();
    const health = await request(app).get("/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    const notFound = await request(app).get("/chat");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, "NOT_FOUND");
  });
});

describe("POST /chat — structured intents", () => {
  const extraction = (actions: object[], reply = "") => JSON.stringify({ actions, reply });
  const base = {
    location: null,
    date: { kind: "unspecified", weekday: null, isoDate: null, offsetDays: null },
    time: { said: false, hour: 0, minute: 0, meridiem: "none", partOfDay: "none" },
    reminderText: null,
    calendarRange: null,
    wantsNextEvent: false,
  };

  it("returns validated device actions and passes the phone's clock to the model", async () => {
    const { chat, llm } = setup();
    llm.replies.push(
      extraction([
        { ...base, type: "set_reminder", reminderText: "Meeting", time: { said: true, hour: 5, minute: 0, meridiem: "pm", partOfDay: "none" } },
      ]),
    );
    const res = await chat({
      text: "Can you set a reminder for my meeting at 5 PM?",
      context: { timeZone: "Asia/Kolkata", localDateTime: "2026-10-23T15:45" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.kind, "actions");
    assert.deepEqual(res.body.result.device, [
      { type: "set_reminder", text: "Meeting", when: { date: { kind: "unspecified" }, time: { hour: 17, minute: 0 } } },
    ]);
    assert.match(llm.calls[0][0].content, /Friday 2026-10-23 15:45 \(Asia\/Kolkata\)/);
  });

  it("answers small talk when the model returns no actions, never raw JSON", async () => {
    const { chat, llm } = setup();
    llm.replies.push(extraction([], "You're welcome! Happy to help."));
    const res = await chat({ text: "Thanku Nexis" });
    assert.equal(res.status, 200);
    assert.equal(res.body.reply.text, "You're welcome! Happy to help.");
    assert.equal(res.body.result.kind, "chat");
  });

  it("does not show broken JSON as a reply", async () => {
    const { chat, llm } = setup();
    llm.replies.push('{"actions": [{"type": "chat"');
    const res = await chat({ text: "Sorry nexis" });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, "UPSTREAM_ERROR");
  });

  it("returns a clarification question as the reply", async () => {
    const { chat, llm } = setup();
    llm.replies.push(extraction([{ ...base, type: "set_alarm" }]));
    const res = await chat({ text: "Set an alarm" });
    assert.equal(res.body.result.kind, "clarify");
    assert.equal(res.body.result.clarification.field, "time");
    assert.equal(res.body.reply.text, "What time should I set the alarm for?");
  });

  it("rejects a malformed clock context", async () => {
    const { chat } = setup();
    const bad = await chat({ text: "hi", context: { timeZone: "not a zone!", localDateTime: "23/10/2026" } });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body.error.details), /IANA|YYYY/);
  });
});
