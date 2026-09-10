// El ÚNICO lugar del repo que lee process.env. Todo lo demás recibe la config
// por constructor o por el container.
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(2567),
  // Compartido con el backend principal. El dominó verifica y NUNCA firma.
  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
});

export interface Env {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly jwtSecret: string;
  readonly logLevel: "debug" | "info";
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
    logLevel: parsed.NODE_ENV === "production" ? "info" : "debug",
  };
}

export const env: Env = parseEnv(process.env);
