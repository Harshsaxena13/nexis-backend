import { z } from "zod";

import type { AssistOutcome } from "./assist.js";

export const MAX_TEXT_CHARS = 1000;

// Control characters other than tab/newline: transcripts never contain them.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// A long run of base64/hex characters with no spaces looks like encoded audio, not speech.
const ENCODED_BLOB = /[A-Za-z0-9+/=]{120,}/;

const transcriptText = z
  .string({ error: "text must be a string" })
  .trim()
  .min(1, "text is empty")
  .max(MAX_TEXT_CHARS, `text is longer than ${MAX_TEXT_CHARS} characters`)
  .refine((t) => !CONTROL_CHARS.test(t), "text contains control characters")
  .refine(
    (t) => !/^data:/i.test(t) && !ENCODED_BLOB.test(t),
    "text looks like encoded binary data; send transcribed text only",
  )
  .refine((t) => /[\p{L}\p{N}]/u.test(t), "text has no letters or digits");

/**
 * POST /chat request body. Strict: unknown fields (e.g. `audio`) are rejected.
 */
export const ChatRequestSchema = z.strictObject({
  /** On-device transcript of what the user said. */
  text: transcriptText,
  /** Omit on the first turn; send back the `sessionId` from each response. */
  sessionId: z.uuid({ error: "sessionId must be a UUID" }).optional(),
  /** Reply language; `auto` mirrors the user. */
  language: z.enum(["en", "hinglish", "auto"]).default("auto"),
  /** Clear this session's context before answering. */
  resetContext: z.boolean().default(false),
  /** The phone's clock, so relative dates ("kal", "next Monday") are understood. */
  context: z
    .strictObject({
      timeZone: z
        .string()
        .max(64)
        .regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*$/, "timeZone must be an IANA name"),
      localDateTime: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "localDateTime must be YYYY-MM-DDTHH:mm"),
    })
    .optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface ChatResponse {
  sessionId: string;
  reply: {
    text: string;
    language: "en" | "hinglish";
    script: "latin" | "devanagari" | "mixed" | "none";
  };
  /** Number of user turns in the session context, including this one. */
  turn: number;
  /** True when the sent sessionId was unknown or expired and a fresh context started. */
  contextRestarted: boolean;
  model: string;
  latencyMs: number;
  /**
   * What the assistant understood and did. `clarify`: reply is a question. `actions`:
   * weather reports are real provider data; device actions must be performed (and
   * confirmed) by the phone. `chat`: reply is a plain answer.
   */
  result: Pick<AssistOutcome, "kind" | "clarification" | "weather" | "device">;
}

export type ErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "SESSION_BUSY"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "NOT_FOUND"
  | "INTERNAL";

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    /** Present on 429/503: wait this long before retrying. */
    retryAfterSec?: number;
    /** Field-level problems for INVALID_INPUT. */
    details?: { field: string; message: string }[];
  };
  requestId: string;
}
