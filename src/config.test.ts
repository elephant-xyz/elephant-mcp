import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mock fs module
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

// Mock AWS credential provider
const mockCredentialProvider = vi.fn();
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => mockCredentialProvider,
}));

// Store original env
const originalEnv = { ...process.env };

// Reset config module between tests
async function resetConfigModule() {
  vi.resetModules();
  const configModule = await import("./config.ts");
  return configModule;
}

describe("config", () => {
  beforeEach(() => {
    // Reset environment to clean state
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    // Clear any cached config
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("hasAwsCredentials", () => {
    it("should return true when AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set", async () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasAwsCredentials } = await resetConfigModule();

      expect(hasAwsCredentials()).toBe(true);
    });

    it("should return false when only AWS_ACCESS_KEY_ID is set", async () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      delete process.env.AWS_SECRET_ACCESS_KEY;
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasAwsCredentials } = await resetConfigModule();

      expect(hasAwsCredentials()).toBe(false);
    });

    it("should return true when AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is set", async () => {
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI =
        "/v2/credentials/uuid";
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasAwsCredentials } = await resetConfigModule();

      expect(hasAwsCredentials()).toBe(true);
    });

    it("should return true when AWS_CONTAINER_CREDENTIALS_FULL_URI is set", async () => {
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI =
        "http://localhost/credentials";
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasAwsCredentials } = await resetConfigModule();

      expect(hasAwsCredentials()).toBe(true);
    });

    it("should return true when AWS_PROFILE is set and credentials file exists", async () => {
      process.env.AWS_PROFILE = "my-profile";
      vi.mocked(existsSync).mockReturnValue(true);

      const { hasAwsCredentials } = await resetConfigModule();

      expect(hasAwsCredentials()).toBe(true);
      expect(existsSync).toHaveBeenCalledWith(
        join(homedir(), ".aws", "credentials"),
      );
    });

    it("should return false when AWS_PROFILE is set but credentials file does not exist", async () => {
      process.env.AWS_PROFILE = "my-profile";
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasAwsCredentials } = await resetConfigModule();

      expect(hasAwsCredentials()).toBe(false);
    });

    it("should return true when default credentials file exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const { hasAwsCredentials } = await resetConfigModule();

      expect(hasAwsCredentials()).toBe(true);
    });

    it("should return false when no credentials are available", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasAwsCredentials } = await resetConfigModule();

      expect(hasAwsCredentials()).toBe(false);
    });
  });

  describe("hasEmbeddingProvider", () => {
    it("should return true when OPENAI_API_KEY is set", async () => {
      process.env.OPENAI_API_KEY = "sk-test-key";
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasEmbeddingProvider } = await resetConfigModule();

      expect(hasEmbeddingProvider()).toBe(true);
    });

    it("should return true when AWS credentials are available", async () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasEmbeddingProvider } = await resetConfigModule();

      expect(hasEmbeddingProvider()).toBe(true);
    });

    it("should return true when AI_GATEWAY_API_KEY is set", async () => {
      process.env.AI_GATEWAY_API_KEY = "gateway-test-key";
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasEmbeddingProvider } = await resetConfigModule();

      expect(hasEmbeddingProvider()).toBe(true);
    });

    it("should return true when VERCEL_OIDC_TOKEN is set", async () => {
      process.env.VERCEL_OIDC_TOKEN = "oidc-test-token";
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasEmbeddingProvider } = await resetConfigModule();

      expect(hasEmbeddingProvider()).toBe(true);
    });

    it("should return false when neither OpenAI nor AWS credentials are available", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { hasEmbeddingProvider } = await resetConfigModule();

      expect(hasEmbeddingProvider()).toBe(false);
    });

    it("should prefer OpenAI when both are available", async () => {
      process.env.OPENAI_API_KEY = "sk-test-key";
      process.env.AI_GATEWAY_API_KEY = "gateway-test-key";
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

      const { hasEmbeddingProvider, getEmbeddingProvider } =
        await resetConfigModule();

      expect(hasEmbeddingProvider()).toBe(true);
      expect(getEmbeddingProvider()).toBe("openai");
    });

    it("should prefer Gateway over Bedrock credentials", async () => {
      process.env.AI_GATEWAY_API_KEY = "gateway-test-key";
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY = "secret";

      const { hasEmbeddingProvider, getEmbeddingProvider } =
        await resetConfigModule();

      expect(hasEmbeddingProvider()).toBe(true);
      expect(getEmbeddingProvider()).toBe("vercel-ai-gateway");
    });
  });

  describe("getEmbeddingProvider", () => {
    it("should return openai when OPENAI_API_KEY is set", async () => {
      process.env.OPENAI_API_KEY = "sk-test-key";

      const { getEmbeddingProvider } = await resetConfigModule();

      expect(getEmbeddingProvider()).toBe("openai");
    });

    it("should return bedrock when OPENAI_API_KEY is not set", async () => {
      delete process.env.OPENAI_API_KEY;

      const { getEmbeddingProvider } = await resetConfigModule();

      expect(getEmbeddingProvider()).toBe("bedrock");
    });

    it("should return Gateway for an explicit Gateway API key", async () => {
      process.env.AI_GATEWAY_API_KEY = "gateway-test-key";

      const { getEmbeddingProvider } = await resetConfigModule();

      expect(getEmbeddingProvider()).toBe("vercel-ai-gateway");
    });

    it("should return Gateway for a Vercel OIDC token", async () => {
      process.env.VERCEL_OIDC_TOKEN = "oidc-test-token";

      const { getEmbeddingProvider } = await resetConfigModule();

      expect(getEmbeddingProvider()).toBe("vercel-ai-gateway");
    });
  });

  describe("getEmbeddingProviderDescription", () => {
    it("should describe OpenAI when API key is set", async () => {
      process.env.OPENAI_API_KEY = "sk-test-key";

      const { getEmbeddingProviderDescription } = await resetConfigModule();

      expect(getEmbeddingProviderDescription()).toBe("OpenAI (OPENAI_API_KEY)");
    });

    it("should describe AWS environment credentials", async () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      vi.mocked(existsSync).mockReturnValue(false);

      const { getEmbeddingProviderDescription } = await resetConfigModule();

      expect(getEmbeddingProviderDescription()).toBe(
        "AWS Bedrock (environment credentials)",
      );
    });

    it("should describe Gateway API-key authentication without exposing it", async () => {
      process.env.AI_GATEWAY_API_KEY = "gateway-secret-value";

      const { getEmbeddingProviderDescription } = await resetConfigModule();
      const description = getEmbeddingProviderDescription();

      expect(description).toBe("Vercel AI Gateway (AI_GATEWAY_API_KEY)");
      expect(description).not.toContain("gateway-secret-value");
    });

    it("should describe Vercel OIDC without exposing the token", async () => {
      process.env.VERCEL_OIDC_TOKEN = "oidc-secret-value";

      const { getEmbeddingProviderDescription } = await resetConfigModule();
      const description = getEmbeddingProviderDescription();

      expect(description).toBe("Vercel AI Gateway (Vercel OIDC)");
      expect(description).not.toContain("oidc-secret-value");
    });

    it("should describe AWS container credentials", async () => {
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI =
        "/v2/credentials/uuid";
      vi.mocked(existsSync).mockReturnValue(false);

      const { getEmbeddingProviderDescription } = await resetConfigModule();

      expect(getEmbeddingProviderDescription()).toBe(
        "AWS Bedrock (container credentials)",
      );
    });

    it("should describe AWS profile", async () => {
      process.env.AWS_PROFILE = "my-profile";
      vi.mocked(existsSync).mockReturnValue(true);

      const { getEmbeddingProviderDescription } = await resetConfigModule();

      expect(getEmbeddingProviderDescription()).toBe(
        "AWS Bedrock (profile: my-profile)",
      );
    });

    it("should describe shared credentials file", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const { getEmbeddingProviderDescription } = await resetConfigModule();

      expect(getEmbeddingProviderDescription()).toBe(
        "AWS Bedrock (shared credentials file)",
      );
    });

    it("should describe none when nothing is configured", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { getEmbeddingProviderDescription } = await resetConfigModule();

      expect(getEmbeddingProviderDescription()).toBe("None configured");
    });
  });

  describe("verifyAwsCredentials", () => {
    it("should return valid with source when credentials resolve successfully", async () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      mockCredentialProvider.mockResolvedValue({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      });
      vi.mocked(existsSync).mockReturnValue(false);

      const { verifyAwsCredentials } = await resetConfigModule();
      const result = await verifyAwsCredentials();

      expect(result.valid).toBe(true);
      expect(result.source).toBe("environment variables");
    });

    it("should return valid with container credentials source", async () => {
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI =
        "/v2/credentials/uuid";
      mockCredentialProvider.mockResolvedValue({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "secret",
      });
      vi.mocked(existsSync).mockReturnValue(false);

      const { verifyAwsCredentials } = await resetConfigModule();
      const result = await verifyAwsCredentials();

      expect(result.valid).toBe(true);
      expect(result.source).toBe("container credentials (ECS/Lambda)");
    });

    it("should return valid with profile source", async () => {
      process.env.AWS_PROFILE = "my-profile";
      mockCredentialProvider.mockResolvedValue({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "secret",
      });
      vi.mocked(existsSync).mockReturnValue(false);

      const { verifyAwsCredentials } = await resetConfigModule();
      const result = await verifyAwsCredentials();

      expect(result.valid).toBe(true);
      expect(result.source).toBe("profile: my-profile");
    });

    it("should return valid with shared credentials file source", async () => {
      mockCredentialProvider.mockResolvedValue({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "secret",
      });
      vi.mocked(existsSync).mockReturnValue(true);

      const { verifyAwsCredentials } = await resetConfigModule();
      const result = await verifyAwsCredentials();

      expect(result.valid).toBe(true);
      expect(result.source).toBe("shared credentials file");
    });

    it("should return valid with instance metadata source when no other indicators", async () => {
      mockCredentialProvider.mockResolvedValue({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "secret",
      });
      vi.mocked(existsSync).mockReturnValue(false);

      const { verifyAwsCredentials } = await resetConfigModule();
      const result = await verifyAwsCredentials();

      expect(result.valid).toBe(true);
      expect(result.source).toBe("instance metadata (IAM role)");
    });

    it("should return invalid with error when credentials fail to resolve", async () => {
      mockCredentialProvider.mockRejectedValue(
        new Error("Could not load credentials from any providers"),
      );
      vi.mocked(existsSync).mockReturnValue(false);

      const { verifyAwsCredentials } = await resetConfigModule();
      const result = await verifyAwsCredentials();

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Could not load credentials");
    });

    it("should return invalid when credentials missing required fields", async () => {
      mockCredentialProvider.mockResolvedValue({});
      vi.mocked(existsSync).mockReturnValue(false);

      const { verifyAwsCredentials } = await resetConfigModule();
      const result = await verifyAwsCredentials();

      expect(result.valid).toBe(false);
      expect(result.error).toContain("missing required fields");
    });
  });

  describe("verifyEmbeddingProvider", () => {
    it("should return OpenAI when API key is set", async () => {
      process.env.OPENAI_API_KEY = "sk-test-key";

      const { verifyEmbeddingProvider } = await resetConfigModule();
      const result = await verifyEmbeddingProvider();

      expect(result.available).toBe(true);
      expect(result.provider).toBe("openai");
      expect(result.source).toBe("OPENAI_API_KEY environment variable");
    });

    it("should return Bedrock when AWS credentials are valid", async () => {
      mockCredentialProvider.mockResolvedValue({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "secret",
      });
      vi.mocked(existsSync).mockReturnValue(true);

      const { verifyEmbeddingProvider } = await resetConfigModule();
      const result = await verifyEmbeddingProvider();

      expect(result.available).toBe(true);
      expect(result.provider).toBe("bedrock");
      expect(result.source).toContain("AWS Bedrock");
    });

    it("should return Gateway when its API key is configured", async () => {
      process.env.AI_GATEWAY_API_KEY = "gateway-secret-value";
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY = "secret";

      const { verifyEmbeddingProvider } = await resetConfigModule();
      const result = await verifyEmbeddingProvider();

      expect(result).toEqual({
        available: true,
        provider: "vercel-ai-gateway",
        source: "Vercel AI Gateway API key",
      });
      expect(JSON.stringify(result)).not.toContain("gateway-secret-value");
      expect(mockCredentialProvider).not.toHaveBeenCalled();
    });

    it("should return Gateway when Vercel OIDC is available", async () => {
      process.env.VERCEL_OIDC_TOKEN = "oidc-secret-value";

      const { verifyEmbeddingProvider } = await resetConfigModule();
      const result = await verifyEmbeddingProvider();

      expect(result).toEqual({
        available: true,
        provider: "vercel-ai-gateway",
        source: "Vercel OIDC identity",
      });
      expect(JSON.stringify(result)).not.toContain("oidc-secret-value");
      expect(mockCredentialProvider).not.toHaveBeenCalled();
    });

    it("should return not available when no provider is configured", async () => {
      mockCredentialProvider.mockRejectedValue(
        new Error("Could not load credentials"),
      );
      vi.mocked(existsSync).mockReturnValue(false);

      const { verifyEmbeddingProvider } = await resetConfigModule();
      const result = await verifyEmbeddingProvider();

      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should prefer OpenAI over Bedrock", async () => {
      process.env.OPENAI_API_KEY = "sk-test-key";
      process.env.AI_GATEWAY_API_KEY = "gateway-test-key";
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY = "secret";

      const { verifyEmbeddingProvider } = await resetConfigModule();
      const result = await verifyEmbeddingProvider();

      expect(result.available).toBe(true);
      expect(result.provider).toBe("openai");
      // AWS credentials should not even be checked
      expect(mockCredentialProvider).not.toHaveBeenCalled();
    });
  });
});
