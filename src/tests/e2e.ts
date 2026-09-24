import { testConfig } from "@/app.config";
import { startServices } from "@/di-container";
import { env } from "@/env";
import type { CreateMatchRequest, MatchParticipant } from "@/features/match";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import jwt from "jsonwebtoken";
import { CASUAL_2P } from "./game-mode-catalog";

// Scaffolding de la app ensamblada. Vive en la raíz porque lobby y match lo consumen; dejar una
// copia en cada feature fue exactamente lo que hizo divergir sus tokens y opciones de sala.
export type ParticipantInput = string | MatchParticipant;

// EL PUERTO LO ELIGE CADA ARCHIVO, y no sale del índice del worker aunque sería más cómodo:
// `src/env-single-reader.test.ts` prohibe que nada bajo `src/` fuera de `env.ts` lea el
// entorno del proceso, y la comodidad de no elegir un número no vale abrirle un hueco a esa
// invariante —que es la que impide que la configuración se lea en dos lados con dos
// defaults—. El guardarraíl busca la SUBSTRING, así que este comentario tampoco puede
// escribirla: es la misma trampa que ya pagó `src/deploy-smoke.test.ts`.
export async function bootTestServer(port: number): Promise<ColyseusTestServer> {
  const server = await boot(testConfig, port);
  // SE ARRANCAN LOS SERVICIOS DE FONDO, y sin esta línea la mitad del servidor está apagada en
  // toda la suite. `startServices()` —el tick del emparejador, la pasada del mantenimiento, el
  // censo y el vigilante de torneos— lo llama `src/main.ts`, que es el que CORRE; los tests
  // importan `app.config.ts`, que es el que se IMPORTA, y esa división existe justamente para
  // que ningún test arrastre lo que main registra.
  //
  // El precio de olvidarlo no es un rojo sino un CUELGUE: dos jugadores encolados nunca se
  // emparejan porque nadie tickea, y el vaciado por mantenimiento no sale porque el emparejador
  // se suscribe al interruptor DENTRO de `start()`. Los dos esperan hasta que vence el test.
  //
  // Va acá y no en cada archivo por lo mismo que el modo del catálogo se siembra en un solo
  // lugar: el que escriba el E2E número veinte no tiene por qué saber esto. `start()` es
  // idempotente —sale temprano si ya hay intervalo— y los cuatro van `unref`eados, así que ni
  // se duplican entre archivos ni sostienen el proceso al terminar.
  startServices();
  return server;
}

export const participantOf = (input: ParticipantInput): MatchParticipant =>
  typeof input === "string"
    ? {
        userId: input,
        displayName: `Jugador ${input}`,
        currency: "VES",
      }
    : input;

// EMITIR tokens es del backend principal y no del dominó, que solo los verifica, así que
// emitirlos para la suite es trabajo del scaffolding. Acepta el `userId` pelado además del
// participante entero: lo único que se firma es el `sub`, y la mitad de los llamadores —los que
// entran al lobby, que no se sienta en ninguna mesa— no tienen un participante que pasar.
export function mintToken(player: string | { readonly userId: string }): string {
  return jwt.sign({ sub: typeof player === "string" ? player : player.userId }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
}

export function casualTable(
  seats: readonly ParticipantInput[],
  seed = "seed-e2e",
  // EL MODO POR PARÁMETRO, y el default es el de dos porque es el de casi toda la suite. Sin
  // esto, una mesa de cuatro se pediría contra `CASUAL_2P` y `configOf` la rechazaría por
  // cantidad — con un error que apunta al pedido cuando lo que está mal es el modo.
  gameModeId: string = CASUAL_2P.uuid,
): CreateMatchRequest {
  const participants = seats.map(participantOf);
  return {
    mode: "CASUAL",
    matchId: `m-${participants.map(({ userId }) => userId).join("-")}`,
    gameModeId,
    participants,
    seed,
    teamAssignment: "SHUFFLED",
    rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  };
}

// Entra un cliente REAL haciéndose pasar por `userId`, por la única vía que el servidor acepta:
// un token firmado. El SDK de prueba tiene UN cliente compartido, así que el token se asigna
// justo antes de cada entrada — lo que funciona porque las entradas van de a una, esperadas.
// El tipo de retorno se INFIERE del SDK en vez de anotarse: su estado se decodifica por
// reflexión, así que escribirlo a mano sería un `any` con nombre.
export async function joinAs(server: ColyseusTestServer, roomId: string, userId: string) {
  server.sdk.auth.token = mintToken(userId);
  return server.sdk.joinById(roomId, {});
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitUntil: se agotó el plazo");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
