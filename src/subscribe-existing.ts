import { env } from "@/env";
import { subscribeExistingModes } from "@/features/game-mode";
import { Mongo } from "@/shared/mongo";
import { flushLogs, logger } from "./logger";

// npm run modes:subscribe-existing -- <providerId...>
//
// LA SUSCRIPCIÓN DE UNA SOLA VEZ. Desde que la lista de suscriptores de un compartido es explícita,
// un modo de antes de las suscripciones —sin el campo `subscribers`— no se le ofrece a nadie. Esto
// les fija la lista a los proveedores que se nombran (los que ya los jugaban; hoy, `betaso`). Sólo
// toca los compartidos SIN el campo, así que correrlo dos veces no cambia nada la segunda vez.
//
// Lee la base de `MONGO_URI` (del `.env` del servicio o del entorno; `src/env.ts` exige además
// `BILLING_AUTH_PUBLIC_KEY`, que cualquier `.env` del dominó ya tiene). No arma el container: no
// levanta servidor, broker ni nada más que esta conexión.
const providerIds = process.argv.slice(2);

function fail(message: string, detail: Record<string, unknown> = {}): never {
  logger.error(message, detail);
  flushLogs();
  process.exit(1);
}

if (providerIds.length === 0) fail("uso: npm run modes:subscribe-existing -- <providerId...>");
if (providerIds.some((id) => id.trim() === "" || id.startsWith("-")))
  fail("providerId inválido", { providerIds });
if (!env.mongoUri) fail("falta MONGO_URI: este script sólo tiene sentido contra la base de verdad");

const mongo = new Mongo(env.mongoUri);
try {
  const modified = await subscribeExistingModes(mongo, providerIds);
  logger.info("compartidos sin lista suscritos", { providerIds, modified });
} finally {
  await mongo.close();
  flushLogs();
}
