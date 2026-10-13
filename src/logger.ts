import { hostname } from "node:os";
import { currentTrace } from "@/shared/trace";
import pino from "pino";
import { type AppEnv, env } from "./env";

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

// LO QUE NUNCA SALE. Un token de jugador en un log es una sesión regalada a quien lea el panel, y
// la llave interna es peor. La lista es corta a propósito: cada patrón cuesta en cada línea.
const REDACTED = ["token", "authorization", "*.token", "*.authorization"];

/**
 * EL PINO DEL PROCESO, con lo que va en toda línea sin que nadie lo pida: la redacción y la causa en
 * curso. Se exporta para que un test arme EL MISMO contra un destino que se pueda leer —el real
 * escribe al fd 1 directo, sin pasar por `process.stdout`—: probarlo con otras opciones probaría
 * otra cosa.
 */
export function createPino(options: {
  readonly level: string;
  readonly base: LogFields;
  readonly destination: pino.DestinationStream;
}): pino.Logger {
  return pino(
    {
      level: options.level,
      base: options.base,
      redact: { paths: REDACTED, censor: "[oculto]" },
      // LA CAUSA EN CURSO, en cada línea y sin que nadie la pase: es lo que junta nuestra mitad de
      // un incidente con la del backend principal. El `traceId` y no el span, que viaja en el cable
      // pero no engorda cada línea. Sólo corre para las líneas que de verdad se escriben.
      mixin: () => {
        const trace = currentTrace();
        return trace === undefined ? {} : { traceId: trace.traceId };
      },
    },
    options.destination,
  );
}

/**
 * QUIÉN HABLA, en cada línea. `hostname` a mano porque pasar `base` PISA el de pino: sin él, un
 * release en dos máquinas da dos líneas `instance: "0"` indistinguibles.
 *
 * `instance` se OMITE si esto no lo levantó pm2, en vez de caer a 0: `undefined` no es el primer
 * worker, es "acá no hay pm2". Y va como TEXTO porque es un identificador y no una cantidad — de
 * paso, el `0` no se comporta como ausente y la primera instancia, que muchas veces es la única,
 * no queda sin etiqueta.
 */
export function baseFieldsOf(options: {
  readonly appEnv: AppEnv;
  readonly instanceIndex: number | undefined;
  readonly release: string | undefined;
}): LogFields {
  return {
    app: "domino-backend-v2",
    // `APP_ENV` y NO `NODE_ENV`: el segundo dice `production` en dev, stage y prod por igual.
    env: options.appEnv,
    hostname: hostname(),
    pid: process.pid,
    ...(options.instanceIndex === undefined ? {} : { instance: String(options.instanceIndex) }),
    ...(options.release === undefined ? {} : { release: options.release }),
  };
}

/**
 * EL DESTINO, y es la única decisión de sumidero del repo.
 *
 * `minLength` convierte miles de escrituras chicas en una cada 4 KB: bajo pm2 y bajo Docker
 * `stdout` es un PIPE, y escribir línea por línea compite con el event loop. Lo que cuesta es
 * `flushLogs()` antes de cada `process.exit`, que es el precio correcto.
 *
 * **`periodicFlush` no es un extra: sin él el buffer es un bug**, de los que sólo se ven corriendo
 * el servidor. Un buffer que espera llenarse guarda el arranque de una instancia ociosa hasta que
 * se juntan 4 KB, y el momento en que uno mira los logs es justo ése. Con el intervalo la latencia
 * queda acotada a un segundo con poco tráfico, y con mucho el buffer se llena antes. El timer es
 * `unref` (`sonic-boom/index.js:264`), así que no retiene a un CLI que ya terminó.
 *
 * **Sin `transport`**: corre en un worker thread, y `process.exit` pierde las líneas en vuelo.
 */
const destination = pino.destination({
  dest: 1,
  minLength: 4096,
  periodicFlush: 1_000,
  sync: false,
});

export const logger = wrap(
  createPino({
    level: env.logLevel,
    base: baseFieldsOf(env),
    destination,
  }),
);

/**
 * VACÍA EL BUFFER, a mano y sincrónico. Lo llama todo camino que termina en `process.exit`: sin
 * esto se pierde lo último que dijo el proceso, que es justo lo que uno quiere leer cuando se muere.
 * No por `pino.flush()`, que busca un `flush` que este destino no expone así.
 */
export const flushLogs = (): void => destination.flushSync();
