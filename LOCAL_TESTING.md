# Local Atlas testing

## Build and unit tests

```bash
npm ci
npm run build
npm run test -- src/atlas
```

The integration fixture generates Zstd Parquet, serves Atlas blocks through a
mock gateway, verifies every CID, and loads a temporary SQLite database.

## Test a local Atlas gateway

Point the server at a local Kubo gateway or fixture server:

```bash
export ATLAS_IPNS=k51-local-test
export ATLAS_GATEWAYS=http://127.0.0.1:8080
export DATABASE_URL=file:/tmp/elephant-atlas.sqlite
npm run build
npm run sync
```

Run the sync command again and verify it reports `unchanged: true`.

Inspect the result: every `CountyTables` table is a same-named SQL table with
`county` and `data_group` columns, and `atlas_state` lists the loaded groups.

```bash
sqlite3 /tmp/elephant-atlas.sqlite ".tables" "SELECT county, data_group FROM atlas_state"
```

## Test stdio

```bash
ATLAS_IPNS="$ATLAS_IPNS" \
ATLAS_GATEWAYS="$ATLAS_GATEWAYS" \
DATABASE_URL="$DATABASE_URL" \
node dist/index.js
```

Initialize MCP, list tools, then call:

1. `listPublishedCounties`
2. `getPropertyQuerySchema` with a county and data group
3. `queryProperties` with a normalized table and read-only SQL
4. `getOracleProperty` with a published property CID

Confirm every data response contains Atlas source CIDs.

## Test hosted Postgres

Run the disposable Postgres harness when a dedicated test database is
available:

```bash
ATLAS_POSTGRES_TEST_URL="$NEON_TEST_DIRECT_URL" \
  npm run test -- src/atlas/postgres.integration.test.ts
```

Use a direct/unpooled URL for synchronization:

```bash
DATABASE_URL="$NEON_DIRECT_URL" node dist/index.js sync
```

Run the HTTP server with a read-only database credential:

```bash
DATABASE_URL="$NEON_READ_ONLY_URL" \
MCP_HTTP_AUTH_TOKEN="$TOKEN" \
npm run start:http
```

Verify the same query returns equivalent rows over `POST /mcp`. HTTP requests
must not contact Atlas gateways or invoke DuckDB.
