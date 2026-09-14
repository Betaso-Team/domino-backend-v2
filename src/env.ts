// El ÚNICO lugar del repo que lee process.env. Todo lo demás recibe la config
// por constructor o por el container. Enforced por src/env-single-reader.test.ts.
//
// Efecto secundario a nivel de módulo: importar este archivo ejecuta `parseEnv(process.env)`
// y lanza de inmediato si el entorno es inválido (p.ej. falta JWT_SECRET) — antes de que
// corra cualquier código propio del importador. En test, vitest.setup.ts pone defaults para
// que esto nunca truene solo por faltar configuración de entorno.
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(2567),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  EXTRA_TIME_RESERVE_MS: z.coerce.number().int().positive().default(30_000),
  DEALING_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PRESENTING_ROUND_MS: z.coerce.number().int().positive().default(6_000),
  PRESENTING_MATCH_MS: z.coerce.number().int().positive().default(6_000),
  SEATING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Cuánto se le guarda el asiento al que se cayó (`allowReconnection`). Va en SEGUNDOS
   * porque esa es la unidad de la API de Colyseus, y convertir acá sería dejar dos números
   * distintos para el mismo plazo.
   *
   * Sale del entorno por la misma razón que las duraciones de fase: el camino de la
   * ventana VENCIDA no se puede testear esperando dos minutos.
   */
  RECONNECTION_WINDOW_SECONDS: z.coerce.number().int().positive().default(120),
  // Compartido con el backend principal. El dominó verifica y NUNCA firma.
  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
  /**
   * La llave de la API INTERNA (consola de soporte). OPCIONAL y sin default a propósito:
   * un default es una llave publicada, y una llave publicada no protege nada.
   *
   * Ausente significa "esta instancia no expone `/internal/*`", y las rutas directamente
   * NO se registran (ver register-http.ts). Es fail closed: una ruta interna viva con la
   * llave vacía es PEOR que no tenerla, porque parece protegida.
   *
   * El mínimo de largo es el mismo criterio que el de JWT_SECRET: una llave corta se
   * enumera, y acá el entorno es o la llave buena o ninguna.
   */
  INTERNAL_API_KEY: z
    .string()
    .min(16, "INTERNAL_API_KEY debe tener al menos 16 caracteres")
    .optional(),
  /**
   * La URI de Mongo, donde queda escrito el historial de cada partida
   * (`mongodb://host:puerto/nombre` — la base viaja en la URI, como en truco y como en v1,
   * para que apuntar a otra sea cambiar UN valor).
   *
   * OPCIONAL, y SU PRESENCIA ES LA QUE ELIGE LA IMPLEMENTACIÓN: sin ella el historial es el
   * de memoria y muere con el proceso; con ella es el de Mongo y sobrevive al reinicio. Es
   * el mismo criterio que `INTERNAL_API_KEY` —la variable ausente es una decisión, no un
   * error— y es deliberadamente lo contrario a un `HISTORY_DRIVER`: un interruptor que
   * NOMBRA la implementación es deuda, no configuración, porque deja escribir "mongo" sin
   * URI y "memory" con una base andando al lado. Acá el dato y la decisión son lo mismo,
   * así que no existe la combinación incoherente.
   *
   * NO tiene default, ni siquiera `mongodb://localhost:27017/domino`: un default haría que
   * una instancia mal configurada arranque creyendo que persiste y escriba en una base
   * equivocada —o en ninguna—, que es peor que no persistir a la vista.
   */
  MONGO_URI: z.string().min(1).optional(),
  /**
   * La URL de Redis (`redis://host:puerto/db`), que es lo que convierte a varios procesos en UN
   * clúster. Del otro lado viven tres cosas: el registro de salas de Colyseus (para que
   * `joinById` encuentre una sala de otro nodo), el presence (para que cada proceso sepa de los
   * otros) y el registro de partidas vivas del dominó (para que `GET /config/:roomId` conteste
   * por una sala que abrió otra instancia).
   *
   * OPCIONAL, Y SU PRESENCIA ES LA QUE ELIGE, igual que `MONGO_URI` y por la misma razón: sin
   * ella Colyseus usa su driver y su presence LOCALES —`@colyseus/core/build/utils/Env.mjs`, los
   * defaults de `matchMaker.setup()`— y el registro de partidas usa el almacén de memoria, que
   * es exactamente lo correcto con UNA instancia. Con ella, los tres pasan a ser compartidos. No
   * hay ningún `CLUSTER_DRIVER` ni lo va a haber: un interruptor que nombra la implementación
   * deja escribir "redis" sin URL, y `src/di-container.test.ts` se pone rojo si aparece.
   *
   * LA BASE VIAJA EN LA URL, y ahí está el aislamiento: dos productos sobre el mismo servidor de
   * Redis —el caso del operador que corre el truco al lado— van en índices distintos. No se
   * portó el `REDIS_KEY_PREFIX` de truco: allá existe por una sola razón, que sus archivos de
   * test corren EN PARALELO contra el mismo Redis y se pelearían la contabilidad de salas, y acá
   * la suite no toca Redis (ver `vitest.setup.ts`, que borra esta variable).
   *
   * NO tiene default, ni siquiera `redis://127.0.0.1:6379`: un default haría que una instancia
   * mal configurada arranque creyendo que forma parte de un clúster.
   */
  REDIS_URL: z.string().min(1).optional(),
  /**
   * CÓMO SE LLEGA A ESTE PROCESO DESDE AFUERA, sin el puerto. Colyseus se lo manda al cliente en
   * la reserva de asiento, y por eso cada instancia anuncia la SUYA: con las salas repartidas, el
   * jugador tiene que conectarse al proceso que hospeda la suya, no a cualquiera.
   *
   * El esquema es el de v1 —un host y el PUERTO COMO PREFIJO DE PATH, `dominio.com/2567`—, así
   * que el proxy que ya rutea v1 sirve igual sin aprender nada nuevo. Lo arma `publicAddress` más
   * abajo con `PORT`, que es el otro valor que el proxy necesita.
   *
   * Ausente ⇒ no se anuncia nada, y eso es LO CORRECTO con una instancia sola: el cliente vuelve
   * al host al que ya le habló.
   */
  SERVER_ADDRESS: z.string().min(1).optional(),
  /**
   * Interruptor de HERRAMIENTA, no de producto: regenera los fixtures golden del replay
   * (`writeGolden` en features/match/tests/e2e-harness.ts). El servidor nunca lo mira.
   * Vive acá igual porque este archivo es el único lector de la configuración del proceso
   * —invariante con test propio en env-single-reader.test.ts—, y un guardarraíl con una
   * excepción por conveniencia deja de ser un guardarraíl.
   * Cualquier valor distinto de "1" lo deja apagado, así que no hay entorno que rechazar.
   */
  WRITE_GOLDEN: z.string().optional(),
});

export interface Env {
  readonly nodeEnv: z.infer<typeof schema>["NODE_ENV"];
  readonly port: number;
  readonly jwtSecret: string;
  /** `undefined` ⇒ esta instancia no expone la API interna. Ver INTERNAL_API_KEY. */
  readonly internalApiKey: string | undefined;
  /** `undefined` ⇒ el historial es el de memoria y muere con el proceso. Ver MONGO_URI. */
  readonly mongoUri: string | undefined;
  /** `undefined` ⇒ este proceso es un clúster de uno: driver, presence y registro locales. */
  readonly redisUrl: string | undefined;
  /** `undefined` ⇒ este proceso no anuncia dirección. Ver SERVER_ADDRESS. */
  readonly publicAddress: string | undefined;
  readonly turnTimeoutMs: number;
  readonly extraTimeReserveMs: number;
  readonly dealingTimeoutMs: number;
  readonly presentingRoundMs: number;
  readonly presentingMatchMs: number;
  readonly seatingTimeoutMs: number;
  readonly reconnectionWindowSeconds: number;
  readonly logLevel: "debug" | "info";
  readonly writeGolden: boolean;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Entorno inválido — ${detail}`);
  }
  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    jwtSecret: parsed.JWT_SECRET,
    internalApiKey: parsed.INTERNAL_API_KEY,
    mongoUri: parsed.MONGO_URI,
    redisUrl: parsed.REDIS_URL,
    // El puerto va COMO PATH y no como `host:puerto`: es el esquema de v1 y es lo que hace que
    // el proxy que ya rutea v1 rutee esto sin aprender nada. Se arma acá —el único lector del
    // entorno— y no en el composition root, para que el formato tenga UN dueño.
    publicAddress: parsed.SERVER_ADDRESS ? `${parsed.SERVER_ADDRESS}/${parsed.PORT}` : undefined,
    turnTimeoutMs: parsed.TURN_TIMEOUT_MS,
    extraTimeReserveMs: parsed.EXTRA_TIME_RESERVE_MS,
    dealingTimeoutMs: parsed.DEALING_TIMEOUT_MS,
    presentingRoundMs: parsed.PRESENTING_ROUND_MS,
    presentingMatchMs: parsed.PRESENTING_MATCH_MS,
    seatingTimeoutMs: parsed.SEATING_TIMEOUT_MS,
    reconnectionWindowSeconds: parsed.RECONNECTION_WINDOW_SECONDS,
    logLevel: parsed.NODE_ENV === "production" ? "info" : "debug",
    writeGolden: parsed.WRITE_GOLDEN === "1",
  };
}

export const env: Env = parseEnv(process.env);
