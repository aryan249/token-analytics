// src/shared/logger.ts

import pino from "pino";

// Logger reads env vars directly so it can be imported anywhere
// without creating a circular dependency through config.ts

const logLevel = (process.env.LOG_LEVEL as pino.Level) || "info";
const nodeEnv  = process.env.NODE_ENV || "development";

export const logger = pino({
  level: logLevel,
  transport:
    nodeEnv === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
      : undefined,
  base: { service: "flaunch" },
});