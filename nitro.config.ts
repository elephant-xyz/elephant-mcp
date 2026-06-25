import { defineNitroConfig } from "nitropack/config";

/**
 * Nitro configuration for the Elephant MCP HTTP server.
 *
 * Write once — deploy anywhere. Select a preset at build time:
 *   npx nitropack build --preset vercel
 *   npx nitropack build --preset cloudflare-pages
 *   npx nitropack build --preset aws-lambda
 *   npx nitropack build --preset node-server   (default)
 *
 * The MCP server is stateless (no sessions), so all presets work correctly.
 */
export default defineNitroConfig({
  // Pin compatibility date for deterministic preset builds.
  compatibilityDate: "2026-06-23",

  // Default preset — override with NITRO_PRESET env var or --preset flag
  preset: (process.env.NITRO_PRESET as string | undefined) ?? "node-server",

  // Expose the MCP HTTP handler as a Nitro server route
  handlers: [
    {
      route: "/mcp",
      handler: "./src/server/nitro-handler.ts",
      method: "post",
    },
    {
      route: "/mcp",
      handler: "./src/server/nitro-handler.ts",
      method: "get",
    },
    {
      route: "/mcp",
      handler: "./src/server/nitro-handler.ts",
      method: "delete",
    },
    {
      route: "/health",
      handler: "./src/server/nitro-handler.ts",
      method: "get",
    },
  ],

  // Environment variables forwarded into the runtime
  runtimeConfig: {
    oracleOpenDataManifestCid: "",
    permitHarvestQueueUrl: "",
    permitHarvestOutputPrefix: "",
    permitCacheManifestCid: "",
    awsRegion: "us-east-1",
  },

  // Externalize heavy Node-only packages so preset bundlers don't try to bundle them
  externals: {
    external: [
      "@modelcontextprotocol/sdk",
      "helia",
      "@helia/json",
      "multiformats",
      "ipfs-only-hash",
      "pino",
      "pino-pretty",
      "@aws-sdk/client-sqs",
      "@aws-sdk/credential-providers",
      "drizzle-orm",
      "@libsql/client",
      "tree-sitter",
      "tree-sitter-javascript",
    ],
  },

  // NOTE: @noble/hashes@1.8.0 ships a malformed package.json (duplicate
  // "./crypto" exports key) that makes "@noble/hashes/crypto" unresolvable in the
  // flattened Nitro bundle (ERR_PACKAGE_PATH_NOT_EXPORTED → 500 at runtime). The
  // post-build `scripts/patch-nitro-noble.mjs` step (npm run build:vercel) repairs
  // the bundle by writing the missing crypto.js shim.

  // Output directory for Nitro build artifacts.
  // The Vercel preset must write to `.vercel/output` (Build Output API v3) so
  // `vercel deploy --prebuilt` can pick it up; other presets use `.nitro`.
  output:
    (process.env.NITRO_PRESET as string | undefined) === "vercel"
      ? undefined
      : {
          dir: ".nitro",
        },
});
