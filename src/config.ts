import { z } from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  // AWS credential environment variables (optional, can also use IAM roles)
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  AWS_SESSION_TOKEN: z.string().min(1).optional(),
  AWS_PROFILE: z.string().min(1).optional(),
  // Container/ECS credential indicators
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: z.string().min(1).optional(),
  AWS_CONTAINER_CREDENTIALS_FULL_URI: z.string().min(1).optional(),
  // EC2 metadata service indicator
  AWS_EC2_METADATA_DISABLED: z.string().optional(),
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

/**
 * Checks if AWS credentials appear to be available.
 * This is a best-effort detection - actual permissions are validated at runtime.
 *
 * AWS credentials can come from:
 * 1. Environment variables (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
 * 2. Shared credentials file (~/.aws/credentials)
 * 3. AWS profile (AWS_PROFILE env var with credentials file)
 * 4. ECS container credentials (AWS_CONTAINER_CREDENTIALS_*)
 * 5. EC2 instance metadata (IAM role) - always available on EC2/ECS/Lambda unless disabled
 */
export function hasAwsCredentials(): boolean {
  const cfg = getConfig();

  // Check explicit environment credentials
  if (cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY) {
    return true;
  }

  // Check for ECS/container credentials
  if (
    cfg.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    cfg.AWS_CONTAINER_CREDENTIALS_FULL_URI
  ) {
    return true;
  }

  // Check for AWS profile (which references credentials file)
  if (cfg.AWS_PROFILE) {
    // Profile is set, check if credentials file exists
    const credentialsPath = join(homedir(), ".aws", "credentials");
    if (existsSync(credentialsPath)) {
      return true;
    }
  }

  // Check for default credentials file (default profile)
  const defaultCredentialsPath = join(homedir(), ".aws", "credentials");
  if (existsSync(defaultCredentialsPath)) {
    return true;
  }

  // EC2 metadata service is available by default on AWS compute
  // Only explicitly disabled if AWS_EC2_METADATA_DISABLED=true
  if (cfg.AWS_EC2_METADATA_DISABLED !== "true") {
    // We can't reliably detect if we're on EC2/ECS/Lambda without network call
    // So we don't assume it's available unless other indicators are present
  }

  return false;
}

/**
 * Checks if at least one embedding provider is configured.
 * Returns true if either OpenAI API key or AWS credentials are available.
 */
export function hasEmbeddingProvider(): boolean {
  const cfg = getConfig();

  // OpenAI is available if API key is set
  if (cfg.OPENAI_API_KEY) {
    return true;
  }

  // Check if AWS credentials appear to be available
  if (hasAwsCredentials()) {
    return true;
  }

  return false;
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

/**
 * Returns a human-readable description of the active embedding provider configuration.
 */
export function getEmbeddingProviderDescription(): string {
  const cfg = getConfig();

  if (cfg.OPENAI_API_KEY) {
    return "OpenAI (OPENAI_API_KEY)";
  }

  if (cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY) {
    return "AWS Bedrock (environment credentials)";
  }

  if (
    cfg.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    cfg.AWS_CONTAINER_CREDENTIALS_FULL_URI
  ) {
    return "AWS Bedrock (container credentials)";
  }

  if (cfg.AWS_PROFILE) {
    return `AWS Bedrock (profile: ${cfg.AWS_PROFILE})`;
  }

  const credentialsPath = join(homedir(), ".aws", "credentials");
  if (existsSync(credentialsPath)) {
    return "AWS Bedrock (shared credentials file)";
  }

  return "None configured";
}
