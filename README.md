# Elephant MCP Server

Elephant MCP connects Claude-compatible clients to the Elephant data graph, exposing discoverable tools for listing data groups, classes, and individual property schemas. The server is published on npm as `@elephant-xyz/mcp`.

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=%40elephant-xyz%2Fmcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBlbGVwaGFudC14eXovbWNwQGxhdGVzdCJdfQ==)
[<img alt="Install in VS Code (npx)" src="https://img.shields.io/badge/Install%20in%20VS%20Code-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22%40elephant-xyz%2Fmcp%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40elephant-xyz%2Fmcp%40latest%22%5D%7D)

## One-Command Start
```bash
npx -y @elephant-xyz/mcp@latest
```

The CLI launches a stdio MCP server, logs to stderr, and immediately emits MCP logging events so clients can confirm connectivity.

## Why Elephant?
- Ready-to-use `npx` launcher compatible with Claude, Cursor, VS Code, Gemini CLI, and other MCP clients.
- Tools to enumerate Elephant data groups, related classes, and full JSON Schema fragments.
- Structured MCP logging to stream diagnostics into every connected client.

## Available Tools
- `listClassesByDataGroup` – Lists classes attached to an Elephant data group, including friendly names and descriptions.
- `listPropertiesByClassName` – Returns schema property keys for a class (excluding transport-only fields).
- `getPropertySchema` – Fetches the full JSON Schema for a specific property and class combination.

## Supported MCP Clients

### Cursor
[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=%40elephant-xyz%2Fmcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBlbGVwaGFudC14eXovbWNwQGxhdGVzdCJdfQ==)

1. Ensure Node.js 22.18+ is installed.
2. Cursor will open a configuration screen pre-filled with:
   ```jsonc
   {
     "command": "npx",
     "args": ["-y", "@elephant-xyz/mcp@latest"]
   }
   ```
3. Save and toggle the Elephant connection inside Cursor’s MCP panel.
4. If you are hacking on a local checkout, switch the command to `npm start` and set `cwd` to your repository path.

### Visual Studio Code
[<img alt="Install in VS Code (npx)" src="https://img.shields.io/badge/Install%20in%20VS%20Code-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22%40elephant-xyz%2Fmcp%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40elephant-xyz%2Fmcp%40latest%22%5D%7D)

1. Install the **Model Context Protocol** extension.
2. Accept the pre-populated install flow above or add manually under *Settings → MCP → Servers* with `npx -y @elephant-xyz/mcp@latest`.
3. Reload VS Code and enable the Elephant server in the MCP panel.

### Claude Code

**Remote server connection (if you deploy Elephant over HTTP)**
```bash
claude mcp add --transport http elephant \
  https://YOUR-DEPLOYED-ENDPOINT/mcp \
  --header "ELEPHANT_API_KEY: YOUR_API_KEY"
```

**Local stdio connection**
```bash
claude mcp add elephant -- npx -y @elephant-xyz/mcp@latest
```

Restart Claude Code after adding the server so the tools appear in the `@tools` palette. Replace the URL and API key placeholders with your deployment details if you expose the server remotely.

### OpenAI Codex (experimental MCP support)
Add this snippet to your Codex configuration:
```jsonc
{
  "mcpServers": {
    "elephant": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@elephant-xyz/mcp@latest"]
    }
  }
}
```
Restart `codex chat` and run `@mcp list` to confirm the Elephant server is connected.

### Gemini CLI
Add an entry to `~/.config/gemini/mcp.yaml`:
```yaml
servers:
  elephant:
    transport: stdio
    command: npx
    args:
      - -y
      - @elephant-xyz/mcp@latest
```
Run `gemini tools sync` to register the server.

## Configuration
The stdio transport means no port or server identity flags are required. Optional environment variables handled by `src/config.ts`:
- `LOG_LEVEL` – Pino log level (`error`, `warn`, `info`, `debug`; defaults to `info`).

## Need to Contribute?
Development setup, testing, and release workflows live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Support
Open an issue with your Node.js version, client details, and any relevant log output if you run into trouble. We're happy to help you get connected. 
