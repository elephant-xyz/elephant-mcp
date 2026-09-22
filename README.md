# Elephant MCP

Elephant MCP exposes lexicon tools and CID-verified Atlas county data through
the Model Context Protocol. Atlas data is synchronized into local SQLite or
hosted Postgres before tools query it; request handlers never query remote
Parquet files.

## Contents

- [Requirements](#requirements)
- [Run locally](#run-locally)
- [Synchronize Atlas](#synchronize-atlas)
- [Storage layout](#storage-layout)
- [Hosted deployment](#hosted-deployment)
- [Tools](#tools)
- [Configuration](#configuration)
- [Development](#development)

## Requirements

- Node.js 22.18 or newer
- Network access to the configured Atlas gateways
- Postgres/Neon only for hosted deployments

## Run locally

```bash
npm install
npm run build
npm start
```

The stdio server stores Atlas data separately from verified-script embeddings
under the Elephant MCP application-data directory. It begins one Atlas sync on
startup. Atlas-backed tool calls wait for the accepted SQL snapshot.

MCP client configuration:

```json
{
  "mcpServers": {
    "elephant": {
      "command": "npx",
      "args": ["-y", "@elephant-xyz/mcp@2"]
    }
  }
}
```

## Synchronize Atlas

Build first, then invoke the packaged CLI subcommand:

```bash
npm run build
npm run sync
```

The command:

1. Resolves the Atlas IPNS index through the configured gateways.
2. Computes the index CID from its bytes.
3. Verifies `CountyIndex`, `CountyTables`, and UnixFS Parquet CIDs.
4. Loads changed groups into SQL through DuckDB.
5. Applies replacements and withdrawals atomically.
6. Prints the synchronized index CID and per-group counts.

An unchanged index performs no database writes.

## Storage layout

The database holds one table per `CountyTables` table, named exactly as
published: one per lexicon class (`property`, `address`, `company`, ...), one
per relationship type (`property_has_address`, ...), and `properties` for the
per-property data-group roots. Columns come from the Parquet parts
(`DESCRIBE read_parquet` with `union_by_name`; new columns are added with
`ALTER TABLE ... ADD COLUMN`) plus `county` and `data_group`.

Primary keys:

| Table | Key |
|---|---|
| lexicon class | `(county, data_group, cid, property_cid)` |
| relationship | `(county, data_group, relationship_cid, property_cid)` |
| `properties` | `(county, data_group, property_cid)` |

Rows are content-addressed and shared by every property that carries them, so
`property_cid` is part of the key. Loading a group deletes its
`county`/`data_group` scope and reinserts it with `ON CONFLICT DO UPDATE`;
withdrawing a group is the delete alone. Both happen in one transaction.

Control tables: `atlas_state` (one row per loaded county/data group with its
archive, tables, and schema CIDs) and `atlas_sync_state` (the accepted index
CID). The `atlas_` prefix is reserved; every other table in the database is
discovered from the catalog as Atlas content.

## Hosted deployment

Set `DATABASE_URL` to a direct `postgres://` or `postgresql://` URL and run
`mcp sync` as a separate job. The HTTP deployment should use a read-only
database credential. HTTP requests never resolve IPNS, download parts, or run
DuckDB ETL.

Start the Node HTTP transport with:

```bash
npm run build
npm run start:http
```

The MCP endpoint is `POST /mcp`; `GET /health` is public. Set
`MCP_HTTP_AUTH_TOKEN` to protect MCP routes.

## Tools

Atlas SQL:

- `listPublishedCounties`
- `listOracleProperties`
- `getOracleProperty`
- `getOracleDatasetInfo`
- `getPropertyQuerySchema`
- `queryProperties`
- `findPropertiesInArea`
- `sumPropertyValueInArea`

Lexicon and verified scripts:

- `listClassesByDataGroup`
- `listPropertiesByClassName`
- `getPropertySchema`
- `getVerifiedScriptExamples`

Atlas data tools require explicit county and data-group scope. `queryProperties`
accepts one read-only SELECT that names the synchronized tables directly
(`property`, `address`, `property_has_address`, `properties`, ...); each one is
shadowed by a CTE filtered to the requested county and data group, and any
identifier that is not one of those tables, their columns, an alias, a function,
or a SQL keyword is rejected, so `atlas_state`, catalogs, and schema-qualified
names fail closed. Responses include the Atlas index, archive, tables, and
schema CIDs.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `ATLAS_IPNS` | Canonical Atlas IPNS name | `k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04` |
| `ATLAS_GATEWAYS` | Comma-separated gateway origins in retry order | Filebase, IPFS.io, dweb.link, w3s.link |
| `DATABASE_URL` | Atlas SQLite or Postgres target | Separate SQLite file under the application-data directory |
| `MCP_HTTP_AUTH_TOKEN` | Bearer token for HTTP MCP routes | Unset |
| `LOG_LEVEL` | `error`, `warn`, `info`, or `debug` | `info` |
| `OPENAI_API_KEY` | OpenAI embeddings for verified scripts | Optional |
| `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` | Vercel AI Gateway embeddings | Optional |
| AWS credential chain | Bedrock embeddings | Optional |

`DATABASE_URL` accepts `file:`, `postgres://`, and `postgresql://`. Database
credentials are never logged.

## Development

```bash
npm run build
npm run test:ci
npm run lint
npm run format:check
```

Atlas tests cover shape validation, CID verification, SQLite synchronization,
idempotence, column evolution, shared content, and withdrawal. The live Atlas
and hosted Neon tests are environment-gated.
