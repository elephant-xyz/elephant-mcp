import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default("us-east-1"),
});

export type Config = z.infer<typeof configSchema>;

let config: Config;

export function getConfig(): Config {
  if (!config) {
    try {
      config = configSchema.parse(process.env);
    } catch (error) {
      console.error("❌ Invalid environment configuration:", error);
      process.exit(1);
    }
  }
  return config;
}

export function isProduction(): boolean {
  return getConfig().NODE_ENV === "production";
}

export function isDevelopment(): boolean {
  return getConfig().NODE_ENV === "development";
}

export function hasEmbeddingProvider(): boolean {
  const cfg = getConfig();
  // OpenAI is available if API key is set
  if (cfg.OPENAI_API_KEY) {
    return true;
  }
  // AWS Bedrock is available via IAM roles (no explicit key needed)
  // We assume it's available when running on AWS (region is always set via default)
  return true;
}

export type EmbeddingProvider = "openai" | "bedrock";

export function getEmbeddingProvider(): EmbeddingProvider {
  const cfg = getConfig();
  // Prefer OpenAI if API key is explicitly provided
  if (cfg.OPENAI_API_KEY) {
    return "openai";
  }
  // Fall back to AWS Bedrock (uses IAM roles for auth)
  return "bedrock";
}
