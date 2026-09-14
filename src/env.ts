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
