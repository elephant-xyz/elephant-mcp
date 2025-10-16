# Elephant MCP Server

Elephant MCP connects Claude-compatible clients to the Elephant data graph, exposing discoverable tools for listing data groups, classes, and individual property schemas.

<p>
  <a href="#cursor-setup"><img src="https://img.shields.io/badge/Add%20to-Cursor-5C6CFF?style=for-the-badge" alt="Add to Cursor"></a>
  <a href="#visual-studio-code-setup"><img src="https://img.shields.io/badge/Add%20to-Visual%20Studio%20Code-007ACC?style=for-the-badge" alt="Add to Visual Studio Code"></a>
</p>

## Why Elephant?
- Single command launch with stdio transport compatible with the Model Context Protocol.
- Tools to enumerate Elephant data groups, joinable classes, and JSON Schema definitions.
- Built-in MCP logging so clients can stream structured server diagnostics.
- Production ready with TypeScript, Vite builds, and semantic-release powered publishing.

## Requirements
- Node.js **22.18.0** or newer (ensures native TypeScript support at runtime).
- Access to the Elephant IPFS gateway used by the bundled tools.

## Quick Start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the production bundle:
   ```bash
   npm run build
   ```
3. Launch the server (stdio transport):
   ```bash
   npm start
   ```
4. When developing locally you can hot-reload with:
   ```bash
   npm run dev
   ```

The server prints lifecycle logs to stdout and immediately emits an MCP logging event so clients can confirm connectivity.

## Available Tools
- `listClassesByDataGroup` – Returns display names and descriptions for every class related to a data group.
- `listPropertiesByClassName` – Lists the JSON Schema property keys available on a class (excluding transport-only fields).
- `getPropertySchema` – Fetches the full JSON Schema for a specific property on a class.

Each tool validates input with Zod, emits structured logs, and returns `createTextResult` output for broad client compatibility.

## Configuration
Environment variables are normalized in `src/config.ts`:

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP port used when running behind a transport proxy (stdio ignores this) | `3000` |
| `SERVER_NAME` | Public name reported to clients | `elephant-mcp` |
| `SERVER_VERSION` | Version string surfaced in MCP handshake | package.json `version` |
| `LOG_LEVEL` | Pino log level | `info` |

Add new variables in `src/config.ts` so they inherit validation and documentation.

## Client Setup

### Cursor Setup
1. Build or install the package so `npm start` is available on your machine.
2. Create (or update) `~/.cursor/mcp.json`:
   ```jsonc
   {
     "elephant": {
       "command": "npm",
       "args": ["start"],
       "cwd": "/absolute/path/to/elephant-mcp",
       "enabled": true
     }
   }
   ```
3. Restart Cursor and open the MCP panel. The Elephant server will appear under *Connections*. Toggle it on to stream the available tools into the chat sidebar.

### Visual Studio Code Setup
1. Install the **Model Context Protocol** extension from the Marketplace.
2. Open the extension settings (gear icon → *Extension Settings*).
3. Under *Servers*, add a new entry named `elephant` that runs `npm start` from your repository directory.
4. Reload VS Code. The extension will list Elephant as an available provider and let you invoke the tools from the MCP panel.

### Claude Code
Claude Desktop (Code) surfaces MCP servers through **Settings → Integrations**.
1. Click **Add MCP Server**.
2. Choose **Custom command** and enter `npm start`.
3. Set the working directory to your Elephant MCP checkout.
4. Save and reconnect. Claude Code now exposes Elephant tools through the `@tools` palette.

### OpenAI Codex
If you are using a Codex build with MCP support enabled:
1. Open your Codex configuration file (refer to the Codex docs for its location).
2. Add a stdio server entry named `elephant` that runs `npm start` with the repository path as `cwd`, similar to:
   ```jsonc
   {
     "mcpServers": {
       "elephant": {
         "type": "stdio",
         "command": "npm",
         "args": ["start"],
         "cwd": "/absolute/path/to/elephant-mcp"
       }
     }
   }
   ```
3. Restart Codex so it loads the new configuration.

### Gemini CLI
Gemini CLI builds that support MCP allow configuring servers via YAML.
1. Locate your `mcp` configuration file (typically under the Gemini CLI config directory).
2. Add:
   ```yaml
   servers:
     elephant:
       transport: stdio
       command: npm
       args:
         - start
       cwd: /absolute/path/to/elephant-mcp
   ```
3. Reload or restart the CLI to register the Elephant server.

> Tip: For all clients above, use `npm run dev` while iterating so changes are reflected without restarts.

## Development Tasks
- `npm run lint` / `npm run lint:fix` – Ensure code quality.
- `npm run format` / `npm run format:check` – Keep Prettier formatting consistent.
- `npm run test` – Run the Vitest suite (watch mode). Use `npm run test:ci` for the JSON report.

## Support
File issues or feature requests in this repository. When reporting problems, include your Node.js version, client tooling, and relevant log output from `dist/index.js`.
