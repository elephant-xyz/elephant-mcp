import { z } from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

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
 * Checks if AWS credentials appear to be available (sync, fast check).
 * This is a best-effort detection based on environment variables and files.
 * For actual credential validation, use verifyAwsCredentials().
 *
 * AWS credentials can come from:
 * 1. Environment variables (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
 * 2. Shared credentials file (~/.aws/credentials)
 * 3. AWS profile (AWS_PROFILE env var with credentials file)
 * 4. ECS container credentials (AWS_CONTAINER_CREDENTIALS_*)
 * 5. EC2 instance metadata (IAM role) - requires async verification
 */
export function hasAwsCredentials(): boolean {
  const cfg = getConfig();
  const credentialsPath = join(homedir(), ".aws", "credentials");

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
  if (cfg.AWS_PROFILE && existsSync(credentialsPath)) {
    return true;
  }

  // Check for default credentials file (default profile)
  if (existsSync(credentialsPath)) {
    return true;
  }

  return false;
}

/**
 * Verifies AWS credentials by actually resolving them through the credential provider chain.
 * This is more accurate than hasAwsCredentials() as it:
 * - Validates that credentials can actually be loaded
 * - Detects EC2/ECS/Lambda IAM roles via metadata service
 * - Returns the credential source for logging
 *
 * Note: This may take up to ~1s if EC2 metadata service times out.
 */
export async function verifyAwsCredentials(): Promise<{
  valid: boolean;
  source?: string;
  error?: string;
}> {
  try {
    const credentialProvider = fromNodeProviderChain();
    const credentials = await credentialProvider();

    // Determine the source based on available indicators
    const cfg = getConfig();
    let source = "AWS credential provider chain";

    if (cfg.AWS_ACCESS_KEY_ID && cfg.AWS_SECRET_ACCESS_KEY) {
      source = "environment variables";
    } else if (
      cfg.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      cfg.AWS_CONTAINER_CREDENTIALS_FULL_URI
    ) {
      source = "container credentials (ECS/Lambda)";
    } else if (cfg.AWS_PROFILE) {
      source = `profile: ${cfg.AWS_PROFILE}`;
    } else if (existsSync(join(homedir(), ".aws", "credentials"))) {
      source = "shared credentials file";
    } else {
      // Likely EC2 instance metadata or other chain source
      source = "instance metadata (IAM role)";
    }

    // Check if credentials have required fields
    if (credentials.accessKeyId && credentials.secretAccessKey) {
      return { valid: true, source };
    }

    return { valid: false, error: "Credentials missing required fields" };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return { valid: false, error: errorMessage };
  }
}

/**
 * Checks if at least one embedding provider is configured (sync, fast check).
 * Returns true if either OpenAI API key or AWS credentials appear to be available.
 * For actual validation, use verifyEmbeddingProvider().
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

/**
 * Verifies that at least one embedding provider is properly configured.
 * This performs actual credential validation for AWS Bedrock.
 *
 * Returns details about the available provider or error information.
 */
export async function verifyEmbeddingProvider(): Promise<{
  available: boolean;
  provider?: "openai" | "bedrock";
  source?: string;
  error?: string;
}> {
  const cfg = getConfig();

  // OpenAI is available if API key is set (no async validation needed)
  if (cfg.OPENAI_API_KEY) {
    return {
      available: true,
      provider: "openai",
      source: "OPENAI_API_KEY environment variable",
    };
  }

  // Try to verify AWS credentials
  const awsResult = await verifyAwsCredentials();
  if (awsResult.valid) {
    return {
      available: true,
      provider: "bedrock",
      source: `AWS Bedrock (${awsResult.source})`,
    };
  }

  // No provider available
  return {
    available: false,
    error:
      awsResult.error ||
      "No embedding provider configured. Set OPENAI_API_KEY or configure AWS credentials.",
  };
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
