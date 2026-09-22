import type { AtlasIndexV1 } from "./contracts.ts";

export interface AtlasSyncStateRow {
  generatedFrom: string;
  indexCid: string;
}

export interface AtlasStateRow {
  archiveCid: string;
  county: string;
  dataGroup: string;
  fips: string;
  publishedAt: string;
  schemaCid: string;
  state: string;
  tablesCid: string;
}

export interface AtlasGroupTarget extends AtlasStateRow {
  action: "load" | "skip";
}

export interface AtlasGroupWithdrawal {
  action: "withdraw";
  county: string;
  dataGroup: string;
}

export interface AtlasSyncPlan {
  generatedFrom: string;
  indexCid: string;
  unchanged: boolean;
  groups: AtlasGroupTarget[];
  withdrawals: AtlasGroupWithdrawal[];
}

function groupKey(county: string, dataGroup: string): string {
  return `${county}\u0000${dataGroup}`;
}

export function planAtlasSync(
  index: AtlasIndexV1,
  indexCid: string,
  syncState: AtlasSyncStateRow | null,
  currentRows: readonly AtlasStateRow[],
): AtlasSyncPlan {
  if (syncState?.indexCid === indexCid) {
    return {
      generatedFrom: index.generated_from,
      indexCid,
      unchanged: true,
      groups: [],
      withdrawals: [],
    };
  }

  const current = new Map(
    currentRows.map((row) => [groupKey(row.county, row.dataGroup), row]),
  );
  const desired = new Set<string>();
  const groups: AtlasGroupTarget[] = [];

  for (const county of index.counties) {
    for (const [dataGroup, group] of Object.entries(county.groups)) {
      const key = groupKey(county.county, dataGroup);
      desired.add(key);
      const previous = current.get(key);
      groups.push({
        action:
          previous?.tablesCid === group.tables &&
          previous.archiveCid === group.cid &&
          previous.schemaCid === group.schema
            ? "skip"
            : "load",
        county: county.county,
        state: county.state,
        fips: county.fips,
        dataGroup,
        archiveCid: group.cid,
        tablesCid: group.tables,
        schemaCid: group.schema,
        publishedAt: group.published_at,
      });
    }
  }

  const withdrawals = currentRows
    .filter((row) => !desired.has(groupKey(row.county, row.dataGroup)))
    .map(
      (row): AtlasGroupWithdrawal => ({
        action: "withdraw",
        county: row.county,
        dataGroup: row.dataGroup,
      }),
    );

  groups.sort(
    (left, right) =>
      left.state.localeCompare(right.state) ||
      left.county.localeCompare(right.county) ||
      left.dataGroup.localeCompare(right.dataGroup),
  );
  withdrawals.sort(
    (left, right) =>
      left.county.localeCompare(right.county) ||
      left.dataGroup.localeCompare(right.dataGroup),
  );

  return {
    generatedFrom: index.generated_from,
    indexCid,
    unchanged: false,
    groups,
    withdrawals,
  };
}
