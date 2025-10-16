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
type DestinationWithWrite = {
  write: (chunk: string) => boolean;
};

type LoggerWithDestination = pino.Logger & {
  destination?: DestinationWithWrite;
};

const loggerWithDestination = logger as LoggerWithDestination;
const destination = loggerWithDestination.destination;
const originalWrite = destination?.write.bind(destination);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPinoLevel = (value: string): value is PinoLevel =>
  (["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const).includes(value as PinoLevel);

if (destination && originalWrite) {
  destination.write = (chunk: string) => {
    try {
      const parsed = JSON.parse(chunk) as Record<string, unknown>;
      const levelValue = parsed.level;
      const levelLabel = typeof levelValue === "string" && isPinoLevel(levelValue) ? levelValue : "info";
      const mcpLevel = pinoToMcpLevel[levelLabel] ?? "info";
      const server = getServerInstance();
      if (server?.isConnected()) {
        const base = isRecord(parsed.base) ? parsed.base : undefined;
        const serviceName =
          (typeof base?.service === "string" && base.service) ||
          (typeof parsed.service === "string" ? parsed.service : null) ||
          "app";
        void server.sendLoggingMessage({
          level: mcpLevel,
          logger: serviceName,
          data: parsed,
        });
      }
    } catch {
      // ignore parse errors
    }
    return originalWrite(chunk);
  };
}
