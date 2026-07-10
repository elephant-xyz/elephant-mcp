# Elephant MCP Server

Elephant MCP connects Claude-compatible clients to the Elephant data graph, exposing discoverable tools for listing data groups, classes, and individual property schemas. The server is published on npm as `@elephant-xyz/mcp`.

> **Embedding Provider:** The `getVerifiedScriptExamples` tool uses text embeddings for semantic code search. The server supports two embedding providers:
> - **OpenAI** (preferred when `OPENAI_API_KEY` is set) - Uses `text-embedding-3-small` with 1024 dimensions
> - **AWS Bedrock** (automatic fallback) - Uses `amazon.titan-embed-text-v2` via IAM authentication
>
> When running on AWS, the server automatically uses Bedrock if no OpenAI key is provided.

## 🚀 Prompt Recommendations

**For best results with Elephant MCP, always specify the Data Group you're working on in your prompts and add `use elephant mcp` at the end.**

**Example prompts:**

```
"I'm working on the 'County' data group. Can you help me explore the available classes? use elephant mcp"

"What properties are available in the 'property' class? I'm working with the 'County' data group. use elephant mcp"
```

This helps the AI understand which data context to use and ensures it leverages the Elephant MCP tools effectively.

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=%40elephant-xyz%2Fmcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBlbGVwaGFudC14eXovbWNwQGxhdGVzdCJdfQ==)
[<img alt="Install in VS Code (npx)" src="https://img.shields.io/badge/Install%20in%20VS%20Code-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22%40elephant-xyz%2Fmcp%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40elephant-xyz%2Fmcp%40latest%22%5D%7D)

> **Heads up:** the one-click badges above install the npm build (`@elephant-xyz/mcp@latest`), which is temporarily behind and does **not** include the query-table tools (`queryProperties`), and one-click cannot set the required `PROPERTY_QUERY_TABLE_MAP`. Until the next npm release, use the manual configuration below (GitHub build).

## Why Elephant?

- Ready-to-use `npx` launcher compatible with Claude, Cursor, VS Code, Gemini CLI, and other MCP clients.
- Tools to enumerate Elephant data groups, related classes, and full JSON Schema fragments.
- Structured MCP logging to stream diagnostics into every connected client.

## Available Tools

- `listClassesByDataGroup` – Lists classes attached to an Elephant data group, including friendly names and descriptions.
- `listPropertiesByClassName` – Returns schema property keys for a class (excluding transport-only fields).
- `getPropertySchema` – Fetches the full JSON Schema for a specific property and class combination.
- `getVerifiedScriptExamples` – Returns a list of working examples of the code, that maps data to the Elephant schema.
- `findPropertiesInArea` – Returns properties whose centroid falls inside a user-supplied bounding box or polygon, sourced from the derived geo index.
- `sumPropertyValueInArea` – Sums the current AVM value of properties whose centroid falls inside a bounding box or polygon.
- `queryProperties` – Runs a read-only SQL `SELECT`/`WITH` over a county's query-table (view `properties`) via embedded DuckDB, for arbitrary counts, filters, and aggregates over owner, address, zip, value, acreage, material, and more.
- `getPropertyQuerySchema` – Returns the query-table's columns and types for a county so callers know what they can query.
- `getOracleProperty` – Fetches the full consolidated record for one property (by parcel id, property id, or CID).
- `listOracleProperties` – Paginated per-county property listing.
- `getOracleDatasetInfo` – Per-county dataset summary (property count, export time, source) plus per-source coverage `datasets[]` (count, %, date range) when `DATASET_COVERAGE_MAP` is configured.
- `getPropertyPermits` – On-demand permit harvest for a parcel.

### Geo tools and data sources

These geo tools read two independent IPFS-published datasets, each resolved at
the doc level by its own IPNS name (no central hosted endpoint — every consumer
runs the server locally via `npx`, see below):

- **Lee property data** — stable IPNS `oracle-open-data-lee`.
- **Derived geo/value index** — separate dataset configured via
  `ORACLE_GEO_INDEX_IPNS` (e.g. `oracle-geo-index-lee`), or a fixed
  `ORACLE_GEO_INDEX_CID`. This index is independent from the property
  open-data vars and is what `findPropertiesInArea` / `sumPropertyValueInArea`
  query.

## Supported MCP Clients

### Cursor

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=%40elephant-xyz%2Fmcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBlbGVwaGFudC14eXovbWNwQGxhdGVzdCJdfQ==)

1. Ensure Node.js 22.18+ is installed.
2. Cursor will open a configuration screen pre-filled with:
   ```jsonc
   {
     "command": "npx",
     "args": ["-y", "@elephant-xyz/mcp@latest"],
     "env": {
       // Option 1: Use OpenAI embeddings
       "OPENAI_API_KEY": "sk-your-openai-key",
       // Option 2: Use AWS Bedrock (omit OPENAI_API_KEY)
       // "AWS_REGION": "us-east-1"  // optional, defaults to us-east-1
       // Recommended: the per-county query-table (powers queryProperties AND all
       // property/geo/dataset tools). A served county needs ONLY this line:
       "PROPERTY_QUERY_TABLE_MAP": "{\"lee\":\"https://ipfs.filebase.io/ipns/k51qzi5uqu5djd4ohcf3qm87dhlt0e270xw8ejhkyia62edr76uj0u05hrf7m5\"}",
       // Optional: per-county hourly coverage snapshots. Use the Filebase/IPNS
       // gateway URL printed by query-db's coverage publish step.
       "DATASET_COVERAGE_MAP": "{\"lee\":\"https://ipfs.filebase.io/ipns/<coverage-ipns-name>\"}",
       // Optional legacy fallback (only for counties NOT in the query-table map):
       // "ORACLE_GEO_INDEX_IPNS": "k51qzi5uqu5djo3756w73x3swtt63g9y7igj7tvv1gs4skjk3haj3fuk7qosdi",
     },
   }
   ```
   For OpenAI, replace the placeholder with your actual key. For AWS Bedrock, remove the `OPENAI_API_KEY` line and ensure your environment has valid AWS credentials (IAM role, environment variables, or AWS credentials file).

`PROPERTY_QUERY_TABLE_MAP` maps each county to its published query-table Parquet on IPFS. It powers `queryProperties` (arbitrary SQL) and is the primary source for `getOracleProperty`, `listOracleProperties`, `getOracleDatasetInfo`, and the geo tools — so a county listed there needs no `ORACLE_*` vars. `DATASET_COVERAGE_MAP` maps each county to the small hourly `dataset-coverage.json` snapshot on Filebase/IPNS; `getOracleDatasetInfo` returns that coverage so donphan can qualify answers, while Miranda's website can read the same public JSON URL directly. Do not configure this to an AWS S3 URL for public users. The `ORACLE_OPEN_DATA_*` / `ORACLE_GEO_INDEX_*` vars are optional fallback for counties not yet in the map.

> **Note:** the query-table tools (`queryProperties`, `getPropertyQuerySchema`) are on `main`. Until the next npm release, install the current build from GitHub — replace the args with `["-y", "github:elephant-xyz/elephant-mcp"]` (first launch builds from source; give it a minute).

3. Save and toggle the Elephant connection inside Cursor's MCP panel.
4. If you are hacking on a local checkout, switch the command to `npm start` and set `cwd` to your repository path.

### Visual Studio Code

[<img alt="Install in VS Code (npx)" src="https://img.shields.io/badge/Install%20in%20VS%20Code-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22%40elephant-xyz%2Fmcp%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40elephant-xyz%2Fmcp%40latest%22%5D%7D)

1. Install the **Model Context Protocol** extension.
2. Accept the pre-populated install flow above or add manually under _Settings → MCP → Servers_ with:
   - OpenAI: `OPENAI_API_KEY=sk-your-openai-key npx -y @elephant-xyz/mcp@latest`
   - AWS Bedrock: `npx -y @elephant-xyz/mcp@latest` (uses IAM credentials from environment)
3. Reload VS Code and enable the Elephant server in the MCP panel.

### Claude Code

macOS/Linux with OpenAI:

```bash
claude mcp add elephant --env OPENAI_API_KEY=sk-your-openai-key -- npx -y @elephant-xyz/mcp@latest
```

macOS/Linux with AWS Bedrock (uses IAM credentials):

```bash
claude mcp add elephant -- npx -y @elephant-xyz/mcp@latest
```

Restart Claude Code after adding the server so the tools appear in the `@tools` palette.

### OpenAI Codex

- **CLI setup**

  With OpenAI:
  ```bash
  codex mcp add elephant --env OPENAI_API_KEY=sk-your-openai-key -- npx -y @elephant-xyz/mcp@latest
  ```

  With AWS Bedrock:
  ```bash
  codex mcp add elephant -- npx -y @elephant-xyz/mcp@latest
  ```

  You can explore additional options with `codex mcp --help`. Inside the Codex TUI, run `/mcp` to view currently connected servers.

- **config.toml setup**
  Edit `~/.codex/config.toml` (or open _MCP settings → Open config.toml_ from the IDE extension) and add:

  For OpenAI:
  ```toml
  [mcp.elephant]
  command = "npx"
  args = ["-y", "@elephant-xyz/mcp@latest"]
  env = { OPENAI_API_KEY = "sk-your-openai-key" }
  ```

  For AWS Bedrock:
  ```toml
  [mcp.elephant]
  command = "npx"
  args = ["-y", "@elephant-xyz/mcp@latest"]
  # Uses IAM credentials from environment; optionally set AWS_REGION
  ```
  Save the file and restart Codex to load the new server.

### Gemini CLI

Create (or edit) `.gemini/settings.json` in your project and add:

With OpenAI:
```jsonc
{
  "mcpServers": {
    "elephant": {
      "command": "npx",
      "args": ["-y", "@elephant-xyz/mcp@latest"],
      "env": {
        "OPENAI_API_KEY": "sk-your-openai-key",
      },
    },
  },
}
```

With AWS Bedrock:
```jsonc
{
  "mcpServers": {
    "elephant": {
      "command": "npx",
      "args": ["-y", "@elephant-xyz/mcp@latest"],
      // Uses IAM credentials from environment
    },
  },
}
```

Restart Gemini CLI or run `gemini tools sync` to pick up the new server.

## Configuration

The stdio transport means no port or server identity flags are required. Environment variables handled by `src/config.ts`:

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key for embeddings. When set, OpenAI is used; otherwise falls back to AWS Bedrock. | _(optional)_ |
| `AWS_REGION` | AWS region for Bedrock API calls. | `us-east-1` |
| `LOG_LEVEL` | Pino log level (`error`, `warn`, `info`, `debug`). | `info` |
| `PROPERTY_QUERY_TABLE_MAP` | **Recommended.** JSON object mapping county → query-table Parquet location (an IPNS gateway URL or a local path), e.g. `{"lee":"https://ipfs.filebase.io/ipns/k51…"}`. County keys are lowercased and hyphenated (`palm-beach`, not `palm_beach`). When a requested `county` is here, all data tools read the query-table via DuckDB; the `ORACLE_*` vars below are unused. | _(optional)_ |
| `PROPERTY_QUERY_TABLE` | Single-county query-table location (fallback when the map is unset). | _(optional)_ |
| `PROPERTY_QUERY_TABLE_DEFAULT_COUNTY` | County the single `PROPERTY_QUERY_TABLE` serves. | _(optional)_ |
| `DATASET_COVERAGE_MAP` | JSON object mapping county → published `dataset-coverage.json` location (a Filebase/IPNS gateway URL or a local path for development), e.g. `{"lee":"https://ipfs.filebase.io/ipns/k51…"}`. When set, `getOracleDatasetInfo` returns `datasets[]` with per-source (appraisal/permits/sunbiz/bbb) `ingestedCount`, `expectedCount`, `completionPercent`, and load timestamps. Coverage is additive — a read failure or slow gateway never breaks dataset-info. Do not use AWS S3 URLs for public users. | _(optional)_ |
| `DATASET_COVERAGE` | Single-county coverage snapshot location (fallback when the map is unset). | _(optional)_ |
| `DATASET_COVERAGE_DEFAULT_COUNTY` | County the single `DATASET_COVERAGE` serves. | _(optional)_ |
| `ORACLE_OPEN_DATA_IPNS_MAP` | JSON object mapping county → IPNS for multi-county deployments, e.g. `{"lee":"k51…lee","palm-beach":"k51…pb"}`. County keys are lowercased and hyphenated. When set, each requested `county` resolves to its own IPNS. | _(optional)_ |
| `ORACLE_OPEN_DATA_DEFAULT_COUNTY` | County used when a request omits `county`. When the map is unset, this is the single-IPNS county. | _(optional)_ |
| `ORACLE_OPEN_DATA_IPNS` | Legacy single-county IPNS of the open-data manifest/index. Used when `ORACLE_OPEN_DATA_IPNS_MAP` is unset/empty, or for the default county. | _(optional)_ |
| `ORACLE_OPEN_DATA_INDEX_CID` / `ORACLE_OPEN_DATA_MANIFEST_CID` | Fixed CID fallback for the default county when IPNS resolution yields nothing. | _(optional)_ |
| `ORACLE_GEO_INDEX_IPNS` | IPNS name of the derived geo/value index (e.g. `oracle-geo-index-lee`); resolved to its current CID at runtime. | _(optional)_ |
| `ORACLE_GEO_INDEX_IPNS_MAP` | JSON object mapping county → IPNS for the geo/value index (same shape as `ORACLE_OPEN_DATA_IPNS_MAP`). | _(optional)_ |
| `ORACLE_GEO_INDEX_DEFAULT_COUNTY` | Default county for the geo/value index when no county is requested. | _(optional)_ |
| `ORACLE_GEO_INDEX_CID` | Fixed CID of the derived geo/value index; used when `ORACLE_GEO_INDEX_IPNS` is unset. | _(optional)_ |

### AWS Bedrock Authentication

When using AWS Bedrock (no `OPENAI_API_KEY` set), the server authenticates using the standard AWS credential chain:
1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. Shared credentials file (`~/.aws/credentials`)
3. ECS/Lambda container credentials (`AWS_CONTAINER_CREDENTIALS_*`)
4. IAM instance role (when running on EC2/ECS/Lambda)

Ensure your IAM role or user has the `bedrock:InvokeModel` permission and access to the `amazon.titan-embed-text-v2:0` embedding model in the configured `AWS_REGION`. In some regions, you must explicitly request access to this model in the AWS Bedrock Console before it can be invoked.

**Important:** At least one embedding provider must be configured. If neither `OPENAI_API_KEY` nor AWS credentials are available, the `getVerifiedScriptExamples` tool will return an error prompting you to configure credentials.

### Credential Verification

At startup, the server verifies embedding provider credentials:
- For **OpenAI**: Checks that `OPENAI_API_KEY` is set
- For **AWS Bedrock**: Resolves credentials through the full AWS credential provider chain and logs the detected source

The verification result is logged and included in the MCP startup message for debugging.

### Database Compatibility

The embedding database is automatically rebuilt when switching between embedding models with different vector dimensions (e.g., switching from a 1536-dimension model to a 1024-dimension model). This ensures the `getVerifiedScriptExamples` tool works correctly after model changes. The server will re-index all verified scripts after a rebuild.

Zod compatibility note: this server and its dependencies require **zod v3**. Installs will fail if a v4 copy is hoisted into `node_modules`; the `postinstall` script enforces the v3 constraint to avoid runtime errors such as `keyValidator._parse is not a function`.

## Need to Contribute?

Development setup, testing, and release workflows live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Support

Open an issue with your Node.js version, client details, and any relevant log output if you run into trouble. We're happy to help you get connected.
