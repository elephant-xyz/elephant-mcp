import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearPermitQueryConnections,
  clearPropertyQueryConnections,
  getPropertyColumns,
} from "../lib/duckdbQuery.ts";
import {
  DATASET_QUERY_CONTRACT_VERSION,
  compileDatasetQueryPlan,
  executeDatasetQueryPlan,
  getDatasetQueryCapabilities,
  type DatasetQueryPlan,
} from "../lib/datasetQuery.ts";
import { registerAllTools } from "./registry.ts";

const savedEnvironment = {
  PROPERTY_QUERY_TABLE_MAP: process.env.PROPERTY_QUERY_TABLE_MAP,
  PERMIT_QUERY_TABLE_MAP: process.env.PERMIT_QUERY_TABLE_MAP,
};
let directory: string;

function basePlan(
  input: Pick<DatasetQueryPlan, "dataset" | "measure"> &
    Partial<Pick<DatasetQueryPlan, "groupBy" | "scopeFilters" | "order">>,
): DatasetQueryPlan {
  return {
    contractVersion: DATASET_QUERY_CONTRACT_VERSION,
    county: "fixture",
    dataset: input.dataset,
    scopeFilters: input.scopeFilters ?? [],
    measure: input.measure,
    groupBy: input.groupBy ?? null,
    order: input.order ?? "value_desc",
    budgets: {
      maxRowsScanned: 100,
      maxGroups: 20,
      timeoutMs: 5_000,
    },
  };
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "dataset-query-test-"));
  const propertyPath = join(directory, "properties.parquet");
  const permitPath = join(directory, "permits.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    `COPY (
       SELECT * FROM (VALUES
         ('33901', 1920, 0.5, 'residential', 'brick', true),
         ('33901', 1940, 2.0, 'residential', 'brick', false),
         ('33902', 2000, 1.5, 'commercial', 'stucco', true),
         ('33902', NULL, NULL, NULL, NULL, NULL),
         ('33903', 1980, 3.0, 'residential', 'wood', false)
       ) AS rows(address_zip, built_year, lot_size_acre,
                 property_usage_type, exterior_wall_material, owner_occupied)
     ) TO '${propertyPath.replaceAll("'", "''")}' (FORMAT PARQUET)`,
  );
  await connection.run(
    `COPY (
       SELECT * FROM (VALUES
         ('Roofing', 'closed', DATE '2024-01-01', 10000.0, 'fixture_portal'),
         ('Roofing', 'open', NULL, NULL, 'fixture_portal'),
         ('Electrical', 'closed', DATE '2025-02-01', 2500.0, 'fixture_portal')
       ) AS rows(improvement_type, improvement_status, completion_date,
                 estimated_job_value, source_system)
     ) TO '${permitPath.replaceAll("'", "''")}' (FORMAT PARQUET)`,
  );
  process.env.PROPERTY_QUERY_TABLE_MAP = JSON.stringify({
    fixture: propertyPath,
  });
  process.env.PERMIT_QUERY_TABLE_MAP = JSON.stringify({
    fixture: permitPath,
  });
  clearPropertyQueryConnections();
  clearPermitQueryConnections();
});

afterAll(() => {
  clearPropertyQueryConnections();
  clearPermitQueryConnections();
  if (savedEnvironment.PROPERTY_QUERY_TABLE_MAP === undefined) {
    delete process.env.PROPERTY_QUERY_TABLE_MAP;
  } else {
    process.env.PROPERTY_QUERY_TABLE_MAP =
      savedEnvironment.PROPERTY_QUERY_TABLE_MAP;
  }
  if (savedEnvironment.PERMIT_QUERY_TABLE_MAP === undefined) {
    delete process.env.PERMIT_QUERY_TABLE_MAP;
  } else {
    process.env.PERMIT_QUERY_TABLE_MAP =
      savedEnvironment.PERMIT_QUERY_TABLE_MAP;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("dataset-query registration and capabilities", () => {
  it("registers the bounded capability and execution tools", () => {
    const names: string[] = [];
    registerAllTools({
      registerTool(name: string) {
        names.push(name);
      },
      // The registry contract is intentionally exercised by a recording fake.
    } as never);

    expect(names).toEqual(
      expect.arrayContaining([
        "getDatasetQueryCapabilities",
        "executeDatasetQueryPlan",
      ]),
    );
  });

  it("exposes safe aggregate fields without owner or address rows", async () => {
    const capabilities = await getDatasetQueryCapabilities("fixture");
    const properties = capabilities.datasets.find(
      (dataset) => dataset.dataset === "properties",
    );
    const permits = capabilities.datasets.find(
      (dataset) => dataset.dataset === "permits",
    );

    expect(properties).toMatchObject({ available: true });
    expect(permits).toMatchObject({ available: true });
    expect(properties?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining([
        "address_zip",
        "built_year",
        "lot_size_acre",
        "property_usage_type",
        "exterior_wall_material",
        "owner_occupied",
      ]),
    );
    expect(properties?.fields.map((field) => field.name)).not.toContain(
      "owner_name",
    );
    expect(capabilities.contract).toMatchObject({
      callerSqlAllowed: false,
      callerUrlsAllowed: false,
      conjunctionOnly: true,
    });
  });
});

describe("typed dataset-query execution", () => {
  it("parameterizes values and rejects fields outside the server allowlist", async () => {
    const columns = await getPropertyColumns("fixture");
    const compiled = compileDatasetQueryPlan(
      basePlan({
        dataset: "properties",
        scopeFilters: [
          {
            field: "property_usage_type",
            operator: "eq",
            value: "residential",
          },
        ],
        measure: { kind: "average", field: "built_year" },
        groupBy: "address_zip",
      }),
      columns,
    );

    expect(compiled.sql).toContain("property_usage_type = $1");
    expect(compiled.sql).not.toContain("residential");
    expect(compiled.parameters).toEqual(["residential"]);
    await expect(
      executeDatasetQueryPlan(
        basePlan({
          dataset: "properties",
          scopeFilters: [
            { field: "owner_name", operator: "eq", value: "private owner" },
          ],
          measure: { kind: "count" },
        }),
      ),
    ).rejects.toThrow("unavailable or not allowlisted");
  });

  it.each([
    {
      family: "age",
      plan: basePlan({
        dataset: "properties",
        measure: { kind: "average", field: "built_year" },
        groupBy: "address_zip",
        order: "value_asc",
      }),
    },
    {
      family: "area",
      plan: basePlan({
        dataset: "properties",
        measure: {
          kind: "share",
          measuredField: "lot_size_acre",
          predicate: [{ field: "lot_size_acre", operator: "gte", value: 1 }],
        },
        groupBy: "address_zip",
      }),
    },
    {
      family: "use",
      plan: basePlan({
        dataset: "properties",
        measure: {
          kind: "share",
          measuredField: "property_usage_type",
          predicate: [
            {
              field: "property_usage_type",
              operator: "eq",
              value: "residential",
            },
          ],
        },
        groupBy: "address_zip",
      }),
    },
    {
      family: "material",
      plan: basePlan({
        dataset: "properties",
        measure: {
          kind: "share",
          measuredField: "exterior_wall_material",
          predicate: [
            {
              field: "exterior_wall_material",
              operator: "eq",
              value: "brick",
            },
          ],
        },
        groupBy: "address_zip",
      }),
    },
    {
      family: "occupancy",
      plan: basePlan({
        dataset: "properties",
        measure: {
          kind: "share",
          measuredField: "owner_occupied",
          predicate: [{ field: "owner_occupied", operator: "eq", value: true }],
        },
        groupBy: "address_zip",
      }),
    },
    {
      family: "permit",
      plan: basePlan({
        dataset: "permits",
        measure: {
          kind: "share",
          measuredField: "improvement_status",
          predicate: [
            { field: "improvement_status", operator: "eq", value: "closed" },
          ],
        },
      }),
    },
  ])("executes the $family family without raw rows", async ({ plan }) => {
    const result = await executeDatasetQueryPlan(plan);

    expect(result.status).toBe("ok");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.denominator > 0)).toBe(true);
    expect(result.rows.every((row) => row.value !== null)).toBe(true);
    expect(result.completeness.semantics).toContain("null means unmeasured");
    expect(result.provenance).toMatchObject({
      countyKey: "fixture",
      locatorKind: "local_fixture",
    });
    expect(result).not.toHaveProperty("sql");
  });

  it("returns stable result identity and refuses incomplete group cardinality", async () => {
    const plan = basePlan({
      dataset: "properties",
      measure: { kind: "count" },
      groupBy: "address_zip",
    });
    const first = await executeDatasetQueryPlan(plan);
    const second = await executeDatasetQueryPlan(plan);
    expect(first.resultHash).toBe(second.resultHash);

    const refused = await executeDatasetQueryPlan({
      ...plan,
      budgets: { ...plan.budgets, maxGroups: 1 },
    });
    expect(refused).toMatchObject({
      status: "refused",
      refusal: "group_cardinality_exceeded",
      truncated: true,
    });

    const rowBudgetRefusal = await executeDatasetQueryPlan({
      ...plan,
      budgets: { ...plan.budgets, maxRowsScanned: 1 },
    });
    expect(rowBudgetRefusal).toMatchObject({
      status: "refused",
      refusal: "row_budget_exceeded",
      rows: [],
    });
  });

  it("represents an empty average as unmeasured instead of failing or zero", async () => {
    const result = await executeDatasetQueryPlan(
      basePlan({
        dataset: "properties",
        scopeFilters: [
          {
            field: "property_usage_type",
            operator: "eq",
            value: "not-present",
          },
        ],
        measure: { kind: "average", field: "built_year" },
      }),
    );

    expect(result).toMatchObject({
      status: "ok",
      rows: [
        {
          numerator: 0,
          denominator: 0,
          value: null,
          measuredCount: 0,
          scopeCount: 0,
        },
      ],
      completeness: {
        measurementPercent: null,
        unmeasuredRows: 0,
      },
    });
  });
});
