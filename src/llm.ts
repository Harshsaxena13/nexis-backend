import Groq, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
} from "groq-sdk";

import type { ErrorCode } from "./contract.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResult {
  text: string;
  model: string;
}

export interface JsonSchemaFormat {
  name: string;
  schema: object;
}

/** The only thing the HTTP layer knows about the model provider. Tests pass a fake. */
export interface LlmClient {
  /** With `jsonSchema`, the reply text is JSON constrained to that schema (strict mode). */
  complete(
    messages: LlmMessage[],
    signal?: AbortSignal,
    jsonSchema?: JsonSchemaFormat,
  ): Promise<LlmResult>;
}

/** Provider failure translated into what the app should do about it. */
export class UpstreamError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly retryAfterSec?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function retryAfterSeconds(
  headers: Headers | undefined,
  fallback: number,
): number {
  const raw = headers?.get("retry-after");
  const seconds = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : fallback;
}

export function mapProviderError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  // Order matters: the timeout class extends the connection error class.
  if (error instanceof APIConnectionTimeoutError) {
    return new UpstreamError(
      "UPSTREAM_TIMEOUT",
      504,
      "The AI service took too long to answer. Please try again.",
      undefined,
      error,
    );
  }
  if (error instanceof APIConnectionError) {
    return new UpstreamError(
      "UPSTREAM_UNAVAILABLE",
      503,
      "Could not reach the AI service. Please try again.",
      5,
      error,
    );
  }
  if (error instanceof RateLimitError) {
    return new UpstreamError(
      "UPSTREAM_RATE_LIMITED",
      429,
      "The AI service is busy. Please wait a moment and try again.",
      retryAfterSeconds(error.headers, 10),
      error,
    );
  }
  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError
  ) {
    // The server's key is wrong; the client cannot fix that.
    return new UpstreamError(
      "UPSTREAM_ERROR",
      502,
      "The AI service rejected the server credentials.",
      undefined,
      error,
    );
  }
  if (error instanceof BadRequestError) {
    return new UpstreamError(
      "UPSTREAM_ERROR",
      502,
      "The AI service could not process this request.",
      undefined,
      error,
    );
  }
  if (
    error instanceof APIError &&
    typeof error.status === "number" &&
    (error.status >= 500 || error.status === 498)
  ) {
    return new UpstreamError(
      "UPSTREAM_UNAVAILABLE",
      503,
      "The AI service is temporarily unavailable. Please try again.",
      retryAfterSeconds(error.headers, 5),
      error,
    );
  }
  return new UpstreamError(
    "UPSTREAM_ERROR",
    502,
    "The AI service returned an error.",
    undefined,
    error,
  );
}

type JsonValidateBody = { error?: { code?: string; failed_generation?: unknown } } | undefined;

function jsonValidateBody(error: unknown): JsonValidateBody | null {
  const cause = error instanceof UpstreamError ? error.cause : error;
  if (!(cause instanceof BadRequestError)) return null;
  const body = cause.error as JsonValidateBody;
  return body?.error?.code === "json_validate_failed" ? body : null;
}

function isJsonValidateFailure(error: unknown): boolean {
  return jsonValidateBody(error) !== null;
}

/**
 * The text Groq rejected in a json_validate_failed error. For small talk the model sometimes
 * answers in plain text instead of JSON; that text is still the answer.
 */
export function failedGeneration(error: unknown): string | null {
  const text = jsonValidateBody(error)?.error?.failed_generation;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

export interface GroqLlmOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxCompletionTokens: number;
}

export class GroqLlm implements LlmClient {
  private readonly client: Groq;

  constructor(private readonly options: GroqLlmOptions) {
    this.client = new Groq({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
  }

  async complete(
    messages: LlmMessage[],
    signal?: AbortSignal,
    jsonSchema?: JsonSchemaFormat,
  ): Promise<LlmResult> {
    try {
      return await this.request(messages, signal, jsonSchema);
    } catch (error) {
      // Groq strict mode intermittently returns 400 json_validate_failed (often with an
      // empty generation) even for prompts that succeed on the next attempt. Retry twice,
      // but only once when the model keeps answering in plain text: it rarely changes its mind.
      let lastError = error;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!jsonSchema || !isJsonValidateFailure(lastError) || signal?.aborted) break;
        if (attempt > 0 && failedGeneration(lastError)) break;
        try {
          return await this.request(messages, signal, jsonSchema);
        } catch (retryError) {
          lastError = retryError;
        }
      }
      // Hand the rejected text to the caller, which uses plain text as a chat reply and never
      // shows broken JSON.
      const text = jsonSchema ? failedGeneration(lastError) : null;
      if (text) return { text, model: this.options.model };
      throw lastError;
    }
  }

  private async request(
    messages: LlmMessage[],
    signal?: AbortSignal,
    jsonSchema?: JsonSchemaFormat,
  ): Promise<LlmResult> {
    const isGptOss = this.options.model.startsWith("openai/gpt-oss");
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.options.model,
          messages,
          max_completion_tokens: this.options.maxCompletionTokens,
          temperature: jsonSchema ? 0.2 : 0.6,
          ...(jsonSchema
            ? {
                response_format: {
                  type: "json_schema" as const,
                  json_schema: { name: jsonSchema.name, schema: jsonSchema.schema as Record<string, unknown>, strict: true },
                },
              }
            : {}),
          // gpt-oss reasons before answering: keep it short for voice latency and out of the reply.
          // (`reasoning_format` is not supported for gpt-oss.)
          ...(isGptOss
            ? { reasoning_effort: "low" as const, include_reasoning: false }
            : {}),
        },
        { signal },
      );
      return {
        text: completion.choices[0]?.message?.content ?? "",
        model: completion.model,
      };
    } catch (error) {
      throw mapProviderError(error);
    }
  }
}
