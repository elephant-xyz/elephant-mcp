import { defineConfig } from "vite";
import { resolve } from "path";

const sharedExternals = [
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/streamableHttp.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "@modelcontextprotocol/sdk/types.js",
  "@aws-sdk/client-sqs",
  "@aws-sdk/credential-providers",
  "express",
  "h3",
  "helia",
  "@helia/json",
  "multiformats",
  // Optional native (node-gyp) addons — lazy-loaded at runtime by the code
  // indexer. Keep external so the bundle never hard-requires them and the build
  // succeeds even when the native module is not installed/buildable.
  "tree-sitter",
  "tree-sitter-javascript",
  "zod",
  "node:crypto",
  "node:http",
  "node:path",
  "node:fs",
  "node:url",
  "node:buffer",
  "node:stream",
  "node:events",
  "node:util",
  "crypto",
  "http",
  "path",
  "fs",
  "url",
  "buffer",
  "stream",
  "events",
  "util",
];

export default defineConfig(({ command: _command }) => ({
  // Build configuration
  build: {
    lib: {
      // Two entry points: stdio (existing) + http (new)
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        "server-http": resolve(__dirname, "src/server/http.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: sharedExternals,
      output: {
        format: "es",
        // Named entry → named file (index.js, server-http.js)
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    ssr: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  ssr: {
    external: ["@modelcontextprotocol/sdk", "express", "zod", "h3"],
  },
}));
