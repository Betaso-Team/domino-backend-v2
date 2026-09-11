import { listen } from "@colyseus/tools";
import app from "./app.config.js";
import { env } from "./env.js";
import { logger } from "./logger.js";

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: String(reason) });
});

await listen(app, env.port);
