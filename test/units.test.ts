import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APIError } from "groq-sdk";

import { loadConfig } from "../src/config.js";
import { GroqLlm } from "../src/llm.js";
import { detectLanguage, detectScript } from "../src/language.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { sanitizeReply } from "../src/reply.js";
import { SessionStore } from "../src/sessions.js";

describe("language detection", () => {
  const cases: [string, "en" | "hinglish"][] = [
    ["What is the weather today?", "en"],
    ["Set a reminder for my main meeting", "en"],
    ["Can we park the car?", "en"],
    ["kal ka weather kaisa hai", "hinglish"],
    ["mujhe 5 baje yaad dila dena", "hinglish"],
    ["acha theek hai", "hinglish"],
    ["मुझे कल का weather बताओ", "hinglish"],
    ["नमस्ते", "hinglish"],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}" -> ${expected}`, () =>
      assert.equal(detectLanguage(text), expected));
  }
  it("detects scripts", () => {
    assert.equal(detectScript("hello"), "latin");
    assert.equal(detectScript("नमस्ते"), "devanagari");
    assert.equal(detectScript("नमस्ते friend"), "mixed");
    assert.equal(detectScript("123 !"), "none");
  });
});

describe("system prompt", () => {
  it("asks for concise spoken output in the right language", () => {
    const en = buildSystemPrompt("en", "devanagari");
    assert.match(en, /at most 2 short sentences/);
    assert.match(en, /no markdown/);
    assert.match(en, /English/);
    assert.match(
      buildSystemPrompt("hinglish", "devanagari"),
      /Devanagari script/,
    );
    assert.match(
      buildSystemPrompt("hinglish", "roman"),
      /entirely in Latin script/,
    );
  });
});

describe("sanitizeReply", () => {
  it("removes markdown, links and think tags", () => {
    assert.equal(
      sanitizeReply(
        "<think>plan</think>## Hi\n- **Bold** item\n[docs](https://a.b) `code`",
        500,
      ),
      "Hi Bold item docs code",
    );
  });
  it("cuts at a sentence end within the limit", () => {
    assert.equal(
      sanitizeReply(
        "First sentence here. Second one is longer than allowed.",
        30,
      ),
      "First sentence here.",
    );
  });
  it("cuts at a Devanagari sentence end", () => {
    assert.equal(
      sanitizeReply(
        "पहला वाक्य यहाँ है। दूसरा वाक्य बहुत लंबा है और सीमा से बाहर है।",
        30,
      ),
      "पहला वाक्य यहाँ है।",
    );
  });
});

describe("SessionStore", () => {
  it("trims old turns in user/assistant pairs", () => {
    const store = new SessionStore({
      maxMessages: 4,
      ttlMs: 60_000,
      maxSessions: 10,
    });
    const { session } = store.getOrCreate(undefined);
    for (let i = 1; i <= 3; i++) store.append(session, `u${i}`, `a${i}`);
    assert.deepEqual(
      store.history(session).map((t) => t.content),
      ["u2", "a2", "u3", "a3"],
    );
    assert.equal(store.history(session)[0].role, "user");
  });

  it("expires idle sessions", () => {
    let now = 0;
    const store = new SessionStore({
      maxMessages: 4,
      ttlMs: 1000,
      maxSessions: 10,
      now: () => now,
    });
    const { session } = store.getOrCreate(undefined);
    now = 2000;
    assert.equal(store.getOrCreate(session.id).isNew, true);
  });

  it("evicts the least recently used session beyond the cap", () => {
    const store = new SessionStore({
      maxMessages: 4,
      ttlMs: 60_000,
      maxSessions: 2,
    });
    const a = store.getOrCreate(undefined).session;
    const b = store.getOrCreate(undefined).session;
    store.getOrCreate(a.id); // touch a
    store.getOrCreate(undefined); // evicts b
    assert.equal(store.getOrCreate(a.id).isNew, false);
    assert.equal(store.getOrCreate(b.id).isNew, true);
  });

  it("locks a session for one request at a time", () => {
    const store = new SessionStore({
      maxMessages: 4,
      ttlMs: 60_000,
      maxSessions: 10,
    });
    const { session } = store.getOrCreate(undefined);
    assert.equal(store.tryLock(session), true);
    assert.equal(store.tryLock(session), false);
    store.unlock(session);
    assert.equal(store.tryLock(session), true);
  });
});

describe("config", () => {
  it("requires GROQ_API_KEY and applies defaults", () => {
    assert.throws(() => loadConfig({}), /GROQ_API_KEY/);
    const config = loadConfig({ GROQ_API_KEY: "gsk_test" });
    assert.equal(config.GROQ_MODEL, "openai/gpt-oss-120b");
    assert.equal(config.PORT, 8787);
    assert.equal(config.HINGLISH_SCRIPT, "devanagari");
  });
  it("rejects bad values", () => {
    assert.throws(
      () => loadConfig({ GROQ_API_KEY: "k", HINGLISH_SCRIPT: "urdu" }),
      /HINGLISH_SCRIPT/,
    );
    assert.throws(
      () => loadConfig({ GROQ_API_KEY: "k", CLIENT_API_KEY: "short" }),
      /CLIENT_API_KEY/,
    );
  });
  it("uses the platform PORT and trusts Render's proxy", () => {
    const render = loadConfig({ GROQ_API_KEY: "k", PORT: "10000", RENDER: "true" });
    assert.equal(render.PORT, 10000);
    assert.equal(render.TRUST_PROXY, "1");
    assert.equal(
      loadConfig({ GROQ_API_KEY: "k", RENDER: "true", TRUST_PROXY: "2" }).TRUST_PROXY,
      "2",
    );
    assert.equal(loadConfig({ GROQ_API_KEY: "k" }).TRUST_PROXY, undefined);
  });
});

describe("GroqLlm json_validate_failed handling", () => {
  const rejected = (failedGeneration: string) =>
    APIError.generate(
      400,
      { error: { message: "Failed to generate JSON", code: "json_validate_failed", failed_generation: failedGeneration } },
      "400",
      new Headers(),
    );
  const schema = { name: "nexis_intent", schema: {} };
  /** A GroqLlm whose HTTP call is replaced by a queue of outcomes. */
  const fakeGroq = (outcomes: (Error | string)[]) => {
    const llm = new GroqLlm({ apiKey: "k", model: "test-model", timeoutMs: 1000, maxRetries: 0, maxCompletionTokens: 64 });
    let calls = 0;
    Object.assign(llm, {
      request: async () => {
        const next = outcomes[calls++];
        if (next instanceof Error) throw next;
        return { text: next, model: "test-model" };
      },
    });
    return { llm, calls: () => calls };
  };

  it("uses the model's plain-text answer after one retry", async () => {
    const { llm, calls } = fakeGroq([rejected("I'm good, thanks for asking!"), rejected("I'm good, thanks!")]);
    const result = await llm.complete([], undefined, schema);
    assert.equal(result.text, "I'm good, thanks!");
    assert.equal(calls(), 2);
  });
  it("retries empty generations twice, then fails", async () => {
    const { llm, calls } = fakeGroq([rejected(""), rejected(""), rejected("")]);
    await assert.rejects(llm.complete([], undefined, schema));
    assert.equal(calls(), 3);
  });
  it("returns valid JSON from a retry", async () => {
    const { llm } = fakeGroq([rejected(""), '{"actions":[],"reply":"Hi"}']);
    assert.equal((await llm.complete([], undefined, schema)).text, '{"actions":[],"reply":"Hi"}');
  });
});
