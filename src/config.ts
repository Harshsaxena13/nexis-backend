import { z } from "zod";

const intFrom = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const EnvSchema = z.object({
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
  GROQ_TIMEOUT_MS: intFrom(15_000, 1_000, 60_000),
  GROQ_MAX_RETRIES: intFrom(1, 0, 3),
  MAX_COMPLETION_TOKENS: intFrom(900, 64, 4096),
  MAX_REPLY_CHARS: intFrom(500, 100, 2000),
  HINGLISH_SCRIPT: z.enum(["devanagari", "roman"]).default("devanagari"),
  PORT: intFrom(8787, 1, 65_535),
  HOST: z.string().default("0.0.0.0"),
  RATE_LIMIT_PER_MINUTE: intFrom(20, 1, 1000),
  CONTEXT_MAX_MESSAGES: intFrom(12, 2, 100),
  SESSION_TTL_MINUTES: intFrom(30, 1, 24 * 60),
  MAX_SESSIONS: intFrom(1000, 10, 100_000),
  /** Optional shared key the app sends as `x-nexis-client-key`. Deters casual abuse; not real auth. */
  CLIENT_API_KEY: z.string().min(16).optional(),
  /**
   * Set when behind a reverse proxy so rate limiting sees real client IPs (e.g. `1`).
   * Defaults to `1` on Render, which always sits behind its load balancer.
   */
  TRUST_PROXY: z.string().optional(),
  LOG_USER_TEXT: z.enum(["true", "false"]).default("false"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  // Render sets RENDER=true on every service.
  if (parsed.data.TRUST_PROXY === undefined && env.RENDER === "true") {
    return { ...parsed.data, TRUST_PROXY: "1" };
  }
  return parsed.data;
}
