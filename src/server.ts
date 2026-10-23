import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GroqLlm } from "./llm.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  console.error(
    "Set these as environment variables (locally: copy .env.example to .env).",
  );
  process.exit(1);
}

const llm = new GroqLlm({
  apiKey: config.GROQ_API_KEY,
  model: config.GROQ_MODEL,
  timeoutMs: config.GROQ_TIMEOUT_MS,
  maxRetries: config.GROQ_MAX_RETRIES,
  maxCompletionTokens: config.MAX_COMPLETION_TOKENS,
});

const { app } = createApp({ config, llm });

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(
    `Nexis backend on http://${config.HOST}:${config.PORT} (model ${config.GROQ_MODEL})`,
  );
});

// Render sends SIGTERM before replacing an instance: finish in-flight replies, then exit.
const SHUTDOWN_GRACE_MS = 20_000;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, closing server`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  });
}
