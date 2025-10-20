import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { simpleGit } from "simple-git";

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
async function ensureLatest(clonePath?: string) {
  clonePath = clonePath ?? path.join(os.homedir(), ".local", "elephant-mcp");
  const exists = await dirExists(clonePath);
  if (exists) {
    const git = simpleGit(clonePath);
    await git.pull("origin", "main");
    return;
  } else {
    await fs.mkdir(clonePath);
    const git = simpleGit(clonePath);
    await git.clone(
      "https://github.com/elephant-xyz/Counties-trasform-scripts.git",
      ".",
    );
  }
}

await ensureLatest();
