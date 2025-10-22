import os from "os";
import path from "path";

export function getDefaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Elephant MCP",
    );
  }
  const xdg = path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "elephant-mcp");
}
