import pino from "pino";
import { env } from "./env";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

// Una sola fachada: la sala crea un child con matchId/roomId/gameModeId. El dominio no
// registra; solo transports y network conocen logging.
// Se EXPORTA para poder medir lo único que esta fachada puede romper: el ORDEN de los argumentos.
// `pino` recibe los campos PRIMERO y el mensaje después; invertirlo no falla, deja logs donde el
// mensaje es el objeto — y eso no se ve hasta que alguien va a buscar un incidente.
export function wrap(instance: pino.Logger): Logger {
  return {
    debug: (message, fields) => instance.debug(fields ?? {}, message),
    info: (message, fields) => instance.info(fields ?? {}, message),
    warn: (message, fields) => instance.warn(fields ?? {}, message),
    error: (message, fields) => instance.error(fields ?? {}, message),
    child: (fields) => wrap(instance.child(fields)),
  };
}

export const logger = wrap(
  pino({ level: env.logLevel, base: { app: "domino-backend-v2", env: env.nodeEnv } }),
);
