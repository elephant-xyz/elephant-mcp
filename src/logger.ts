import pino from "pino";
import { getConfig } from "./config.ts";
import { getServerInstance } from "./lib/serverRef.ts";

const config = getConfig();

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    // Base fields for all log entries
    base: {
      service: config.SERVER_NAME,
      version: config.SERVER_VERSION,
      environment: config.NODE_ENV,
    },
    // OpenTelemetry trace correlation
    // When OTel is present, pino will automatically include traceId and spanId
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  // IMPORTANT: write logs to stderr so stdout remains clean for MCP stdio transport
  pino.destination(2),
);

// Bridge Pino logs to MCP logging notifications when possible
type PinoLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
const pinoToMcpLevel: Record<PinoLevel, "debug" | "info" | "notice" | "warning" | "error" | "critical"> = {
  fatal: "critical",
  error: "error",
  warn: "warning",
  info: "info",
  debug: "debug",
  trace: "debug",
  silent: "info",
};

logger.on("level-change", () => {
  // no-op; level mapped per message
});

// Hook into pino's destination write by adding a child logger with hook
const originalWrite = (logger as any).destination?.write as undefined | ((s: string) => boolean);

if (originalWrite) {
  (logger as any).destination.write = (s: string) => {
    try {
      const json = JSON.parse(s);
      const levelLabel: PinoLevel = (json.level as string) as PinoLevel;
      const mcpLevel = pinoToMcpLevel[levelLabel] ?? "info";
      const server = getServerInstance();
      if (server?.isConnected()) {
        void server.sendLoggingMessage({
          level: mcpLevel,
          logger: json?.base?.service ?? json?.service ?? "app",
          data: json,
        });
      }
    } catch {
      // ignore parse errors
    }
    return originalWrite.call((logger as any).destination, s);
  };
}
