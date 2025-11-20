import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let pkgPath;
try {
  pkgPath = require.resolve("zod/package.json");
} catch (error) {
  console.error("Could not resolve zod. Install dependencies before running this script.");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const major = Number.parseInt(version.split(".")[0], 10);

if (Number.isNaN(major)) {
  console.error(`Unexpected zod version string: ${version}`);
  process.exit(1);
}

if (major !== 3) {
  console.error(
    `This project supports zod v3 only. Detected v${version}. Install zod@3.x and retry.`,
  );
  process.exit(1);
}

console.log(`zod ${version} detected (ok)`);
