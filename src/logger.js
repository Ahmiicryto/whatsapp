import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.isTest ? "silent" : config.logLevel,
  redact: {
    paths: [
      "*.phone",
      "*.phone_e164",
      "*.email",
      "*.address1",
      "*.token",
      "*.accessToken",
      "*.password",
      "req.headers.cookie",
      "req.headers.authorization",
    ],
    censor: "[redacted]",
  },
});
