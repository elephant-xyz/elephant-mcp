/**
 * Post-build patch for the Nitro Vercel bundle.
 *
 * @noble/hashes@1.8.0 ships a malformed package.json with a DUPLICATE "./crypto"
 * exports key. Node resolves the LAST one ("./crypto": "./crypto.js"), but Nitro's
 * dependency tracer follows the FIRST (node => esm/cryptoNode.js) and therefore
 * only copies esm/cryptoNode.js into the flattened bundle — it never copies the
 * package-root crypto.js that the winning export actually points to. At runtime
 * `import { crypto } from "@noble/hashes/crypto"` then throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED and the whole serverless function crashes (500).
 *
 * Worse, the bare specifier `import "@noble/hashes/crypto"` inside the flattened
 * 1.8.0 copy does NOT self-resolve to its own (flattened, version-suffixed)
 * directory — Node resolves it to the nearest top-level node_modules/@noble/hashes,
 * which in this bundle is a DIFFERENT version (2.0.1) that has no "./crypto" export
 * at all. So even a correctly-shaped 1.8.0 package wouldn't be consulted.
 *
 * This patch does two things, idempotently:
 *   1. Writes the missing crypto.js / esm/crypto.js WebCrypto shim into every
 *      flattened @noble/hashes copy (so its own subpath would resolve).
 *   2. Rewrites the bare `from "@noble/hashes/crypto"` import inside each flattened
 *      copy to a RELATIVE path to that copy's own crypto shim — so it no longer
 *      leaks to the wrong top-level @noble/hashes version.
 */
import {
  readdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";

const OUTPUT_ROOT = ".vercel/output/functions";

// The exact contents of @noble/hashes/crypto.js (WebCrypto shim, CJS form is
// equivalent; the package is dual but the winning export string is "./crypto.js").
const CRYPTO_SHIM =
  "export const crypto = typeof globalThis === 'object' && 'crypto' in globalThis ? globalThis.crypto : undefined;\n";

function findNobleHashesDirs(root) {
  const found = [];
  if (!existsSync(root)) return found;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      // Match .../@noble/hashes  OR  .../@noble/hashes@x.y.z (flattened)
      if (e.name === "hashes" || e.name.startsWith("hashes@")) {
        if (full.includes(`@noble${pathSep()}`)) {
          found.push(full);
          continue; // don't descend into the package itself
        }
      }
      stack.push(full);
    }
  }
  return found;
}

function pathSep() {
  return process.platform === "win32" ? "\\" : "/";
}

let patched = 0;
const dirs = findNobleHashesDirs(OUTPUT_ROOT);
for (const pkgDir of dirs) {
  // The winning "./crypto" export points to "./crypto.js" at the package root.
  const target = join(pkgDir, "crypto.js");
  if (!existsSync(target)) {
    writeFileSync(target, CRYPTO_SHIM);
    patched++;
    console.log(`[patch-nitro-noble] wrote missing ${target}`);
  }
  // Also ensure esm/crypto.js exists for the "import" condition path.
  const esmDir = join(pkgDir, "esm");
  let esmCryptoPath = null;
  if (existsSync(esmDir) && statSync(esmDir).isDirectory()) {
    esmCryptoPath = join(esmDir, "crypto.js");
    if (!existsSync(esmCryptoPath)) {
      writeFileSync(esmCryptoPath, CRYPTO_SHIM);
      patched++;
      console.log(`[patch-nitro-noble] wrote missing ${esmCryptoPath}`);
    }
  }

  // Rewrite bare `from "@noble/hashes/crypto"` imports inside this flattened copy
  // to a relative path to its OWN crypto shim, so they don't leak to a different
  // top-level @noble/hashes version that lacks the "./crypto" export.
  if (esmCryptoPath) {
    const utilsFile = join(esmDir, "utils.js");
    if (existsSync(utilsFile)) {
      const src = readFileSync(utilsFile, "utf8");
      if (src.includes("@noble/hashes/crypto")) {
        let rel = relative(dirname(utilsFile), esmCryptoPath).replace(
          /\\/g,
          "/",
        );
        if (!rel.startsWith(".")) rel = "./" + rel;
        const next = src.replaceAll("@noble/hashes/crypto", rel);
        writeFileSync(utilsFile, next);
        patched++;
        console.log(
          `[patch-nitro-noble] rewrote @noble/hashes/crypto -> ${rel} in ${utilsFile}`,
        );
      }
    }
  }
}

console.log(
  `[patch-nitro-noble] scanned ${dirs.length} @noble/hashes dir(s), patched ${patched} file(s)`,
);
