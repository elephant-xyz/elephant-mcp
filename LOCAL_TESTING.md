# Local testing — donphan (uxie) → queryProperties → DuckDB → Lee parquet

How to run the **local** elephant-mcp build as a stdio MCP server in Cursor and
drive the DuckDB-backed `queryProperties` / `getPropertyQuerySchema` tools against
the real Lee query table. Everything here is local — nothing is published to npm.

## 1. Build the local server

The stdio entry (`src/index.ts`) imports `package.json`, which Node ≥26 refuses to
load as raw TS without JSON import attributes — so run the **built** `dist/index.js`,
not `src/index.ts` directly.

```bash
cd /Users/stefanmicic/Desktop/Klijenti/elephant/elephant-mcp
npm run build        # vite build → dist/index.js  (re-run after any src change)
```

Sanity-check the server starts and lists the two tools (optional):

```bash
node dist/index.js   # Ctrl-C to stop; it speaks JSON-RPC over stdin/stdout
```

## 2. Cursor MCP config

Point Cursor at the **local** `dist/index.js` (NOT `npx @elephant-xyz/mcp`). Add this
server entry to `~/.cursor/mcp.json` (or a project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "elephant-mcp-local": {
      "command": "node",
      "args": [
        "/Users/stefanmicic/Desktop/Klijenti/elephant/elephant-mcp/dist/index.js"
      ],
      "env": {
        "PROPERTY_QUERY_TABLE_MAP": "{\"lee\":\"/Users/stefanmicic/Desktop/Klijenti/elephant/elephant-query-db/.query-table-export/lee/query-table.parquet\"}"
      }
    }
  }
}
```

`PROPERTY_QUERY_TABLE_MAP` is a JSON string mapping county → parquet location, so the
value is JSON-inside-JSON (the inner quotes are escaped). After saving, reload Cursor
and enable the `elephant-mcp-local` server. You should see `queryProperties` and
`getPropertyQuerySchema` among its tools.

## 3. Invoke donphan (uxie) in Cursor

`donphan` is the codename for the `uxie` agent (`soofi-xyz-team-kit/agents/uxie.md`).
In Cursor, select/invoke the **donphan** (uxie) agent and ask a Lee question. For
structured/aggregate/attribute questions it will call `getPropertyQuerySchema` for
`lee` to learn the columns, then write a single `SELECT` and call `queryProperties`.

## 4. Sample questions that WORK on Lee

All five verified against the real Lee parquet (511,695 rows):

| # | Ask | SQL donphan runs | Verified answer |
|---|-----|------------------|-----------------|
| 1 | How many Lee properties have an owner named "Bailey"? | `SELECT count(*) AS n FROM properties WHERE owners_text ILIKE '%Bailey%'` | **322** |
| 2 | How many properties are in Cape Coral? | `SELECT count(*) AS n FROM properties WHERE address_city ILIKE 'Cape Coral'` | **131,446** |
| 3 | Top 5 properties by market value | `SELECT owners_text, address_city, market_value FROM properties ORDER BY market_value DESC NULLS LAST LIMIT 5` | Lee Health System ($428,658,471) … |
| 4 | How many properties are worth over $1M? | `SELECT count(*) AS n FROM properties WHERE market_value > 1000000` | **23,900** |
| 5 | Look up the owner of a specific property | `SELECT owners_text, address_city, market_value FROM properties WHERE owners_text ILIKE '%Bailey%' LIMIT 5` | rows (e.g. "Marta A Bailey", Cape Coral, $44,413) |

Total row count check: `SELECT count(*) FROM properties` → **511,695**.

## 5. Questions that do NOT work on Lee (and why)

These columns exist in the schema but are **entirely NULL for Lee** — its appraiser
source does not provide them (verified: `count()` returns 0 non-null for each):

- **Acreage** — `lot_size_acre` (0 non-null). "properties over 5 acres" cannot be answered.
- **Wall / roof material** — `exterior_wall_material`, `roof_covering_material` (0 non-null). "how many have a tile roof" cannot be answered.
- **HOA** — `hoa_flag` is NULL for **every** county, not just Lee.

For these, donphan should check the schema / a `count(<column>)`, then say the data is
not available for Lee rather than inventing an answer. Well-covered Lee columns include
`market_value` (511,412 non-null), `address_city` (all 511,695), and `owners_text`
(498,627 non-null).

## Verified run (evidence)

A JSON-RPC-over-stdio probe (`initialize` → `tools/list` → `tools/call`) against
`node dist/index.js` with the env above confirmed:

- `queryProperties` and `getPropertyQuerySchema` both appear in `tools/list`.
- `SELECT count(*) FROM properties` → `{"n":"511695"}`.
- `owners_text ILIKE '%Bailey%'` → real rows (Bruce Bailey/Boca Grande, Marta A Bailey/Cape Coral, …).
- `getPropertyQuerySchema` → 37 columns.
