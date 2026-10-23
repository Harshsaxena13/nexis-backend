import { randomUUID, timingSafeEqual } from "node:crypto";

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { rateLimit, type AugmentedRequest } from "express-rate-limit";

import type { Config } from "./config.js";
import {
  ChatRequestSchema,
  type ChatResponse,
  type ErrorCode,
  type ErrorResponse,
} from "./contract.js";
import { detectScript, resolveReplyLanguage } from "./language.js";
import {
  mapProviderError,
  UpstreamError,
  type LlmClient,
  type LlmMessage,
} from "./llm.js";
import { runAssist } from "./assist.js";
import { EXTRACTION_JSON_SCHEMA, LlmExtractionSchema, type LlmExtraction } from "./intents.js";
import { buildSystemPrompt, buildTurnNote } from "./prompt.js";
import { OpenMeteoProvider, type WeatherProvider } from "./weather.js";
import { sanitizeReply } from "./reply.js";
import { SessionStore } from "./sessions.js";

const BODY_LIMIT = "8kb";

export type AppConfig = Pick<
  Config,
  | "GROQ_MODEL"
  | "MAX_REPLY_CHARS"
  | "HINGLISH_SCRIPT"
  | "RATE_LIMIT_PER_MINUTE"
  | "CONTEXT_MAX_MESSAGES"
  | "SESSION_TTL_MINUTES"
  | "MAX_SESSIONS"
  | "CLIENT_API_KEY"
  | "TRUST_PROXY"
  | "LOG_USER_TEXT"
>;

export interface AppDeps {
  config: AppConfig;
  llm: LlmClient;
  sessions?: SessionStore;
  /** Real forecasts come from here; tests pass a fake. */
  weather?: WeatherProvider;
  log?: (entry: Record<string, unknown>) => void;
}

/** Strict structured output should always parse; if it ever doesn't, fall back to plain chat. */
function parseExtraction(text: string): LlmExtraction {
  try {
    const parsed = LlmExtractionSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON.
  }
  return {
    actions: [
      {
        type: "chat",
        location: null,
        date: { kind: "unspecified", weekday: null, isoDate: null, offsetDays: null },
        time: { said: false, hour: 0, minute: 0, meridiem: "none", partOfDay: "none" },
        reminderText: null,
        calendarRange: null,
        wantsNextEvent: false,
      },
    ],
    reply: text,
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Partial<ErrorResponse["error"]> = {},
  ) {
    super(message);
  }
}

function requestId(res: Response): string {
  return String(res.locals.requestId ?? "");
}

function sendError(
  res: Response,
  status: number,
  error: ErrorResponse["error"],
) {
  if (error.retryAfterSec !== undefined)
    res.setHeader("Retry-After", String(error.retryAfterSec));
  const body: ErrorResponse = { error, requestId: requestId(res) };
  res.status(status).json(body);
}

function keysMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({
  config,
  llm,
  sessions,
  weather = new OpenMeteoProvider(),
  log = (e) => console.log(JSON.stringify(e)),
}: AppDeps) {
  const store =
    sessions ??
    new SessionStore({
      maxMessages: config.CONTEXT_MAX_MESSAGES,
      ttlMs: config.SESSION_TTL_MINUTES * 60_000,
      maxSessions: config.MAX_SESSIONS,
    });

  const app = express();
  app.disable("x-powered-by");
  if (config.TRUST_PROXY) {
    const hops = Number(config.TRUST_PROXY);
    app.set("trust proxy", Number.isFinite(hops) ? hops : config.TRUST_PROXY);
  }

  app.use((req, res, next) => {
    const id = randomUUID();
    res.locals.requestId = id;
    res.setHeader("X-Request-Id", id);
    const started = Date.now();
    res.on("finish", () => {
      log({
        requestId: id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, model: config.GROQ_MODEL, sessions: store.size });
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.RATE_LIMIT_PER_MINUTE,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) => {
      const resetTime = (req as AugmentedRequest).rateLimit?.resetTime;
      const retryAfterSec = resetTime
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : 60;
      sendError(res, 429, {
        code: "RATE_LIMITED",
        message: "Too many requests. Please slow down.",
        retryAfterSec,
      });
    },
  });

  // Text only: anything that is not JSON (audio, multipart, form data) is refused before parsing.
  const requireJson = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.is("application/json")) {
      next(
        new HttpError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Send JSON with Content-Type: application/json. Audio is not accepted.",
        ),
      );
      return;
    }
    next();
  };

  const requireClientKey = (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    if (!config.CLIENT_API_KEY) return next();
    const given = req.get("x-nexis-client-key") ?? "";
    if (!keysMatch(given, config.CLIENT_API_KEY)) {
      next(
        new HttpError(401, "UNAUTHORIZED", "Missing or invalid client key."),
      );
      return;
    }
    next();
  };

  app.post(
    "/chat",
    requireClientKey,
    limiter,
    requireJson,
    express.json({ limit: BODY_LIMIT, strict: true }),
    async (req: Request, res: Response) => {
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "INVALID_INPUT", "Request body is invalid.", {
          details: parsed.error.issues.map((i) => ({
            field: i.path.join(".") || "(body)",
            message: i.message,
          })),
        });
      }
      const input = parsed.data;
      const { session, isNew } = store.getOrCreate(input.sessionId);
      if (!store.tryLock(session)) {
        throw new HttpError(
          409,
          "SESSION_BUSY",
          "The previous message in this conversation is still being answered.",
        );
      }

      const started = Date.now();
      try {
        if (input.resetContext) store.reset(session);
        const language = resolveReplyLanguage(input.language, input.text);
        const messages: LlmMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt(
              language,
              config.HINGLISH_SCRIPT,
              input.context,
            ),
          },
          ...store.history(session),
          {
            role: "system",
            content: buildTurnNote(language, config.HINGLISH_SCRIPT),
          },
          { role: "user", content: input.text },
        ];

        // Stop paying for a completion nobody will read.
        const abort = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) abort.abort();
        });

        const result = await llm
          .complete(messages, abort.signal, {
            name: "nexis_intent",
            schema: EXTRACTION_JSON_SCHEMA,
          })
          .catch((e: unknown) => {
            throw mapProviderError(e);
          });
        const outcome = await runAssist(parseExtraction(result.text), {
          userText: input.text,
          language,
          script: config.HINGLISH_SCRIPT,
          weather,
        });
        const replyText = sanitizeReply(
          outcome.replyText,
          config.MAX_REPLY_CHARS,
        );
        if (!replyText) {
          throw new HttpError(
            502,
            "UPSTREAM_ERROR",
            "The AI service returned an empty answer. Please try again.",
          );
        }

        store.append(session, input.text, replyText);
        if (config.LOG_USER_TEXT === "true") {
          log({ requestId: requestId(res), userText: input.text, replyText });
        }

        const body: ChatResponse = {
          sessionId: session.id,
          reply: { text: replyText, language, script: detectScript(replyText) },
          turn: store.history(session).filter((t) => t.role === "user").length,
          contextRestarted: Boolean(input.sessionId) && isNew,
          model: result.model,
          latencyMs: Date.now() - started,
          result: {
            kind: outcome.kind,
            clarification: outcome.clarification,
            weather: outcome.weather,
            device: outcome.device,
          },
        };
        res.json(body);
      } finally {
        store.unlock(session);
      }
    },
  );

  app.use((_req, res) => {
    sendError(res, 404, {
      code: "NOT_FOUND",
      message: "Not found. Use POST /chat.",
    });
  });

  // Express 5 forwards rejected async handlers here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return sendError(res, err.status, {
        code: err.code,
        message: err.message,
        ...err.extra,
      });
    }
    const type = (err as { type?: string })?.type;
    if (type === "entity.too.large") {
      return sendError(res, 413, {
        code: "PAYLOAD_TOO_LARGE",
        message: `Body exceeds ${BODY_LIMIT}. Send short transcribed text only.`,
      });
    }
    if (type === "entity.parse.failed") {
      return sendError(res, 400, {
        code: "INVALID_INPUT",
        message: "Body is not valid JSON.",
      });
    }
    if (err instanceof UpstreamError) {
      const upstream = err;
      log({
        requestId: requestId(res),
        upstreamError: upstream.code,
        detail: String(upstream.cause ?? ""),
      });
      return sendError(res, upstream.httpStatus, {
        code: upstream.code,
        message: upstream.message,
        retryAfterSec: upstream.retryAfterSec,
      });
    }
    log({ requestId: requestId(res), unhandledError: String(err) });
    return sendError(res, 500, {
      code: "INTERNAL",
      message: "Something went wrong on the server.",
    });
  });

  return { app, sessions: store };
}
