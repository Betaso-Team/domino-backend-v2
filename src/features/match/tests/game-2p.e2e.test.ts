import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boneyardCountOf } from "../core/engine/state-projections";
import {
  type SeatedMatch,
  act,
  bootServer,
  historyOf,
  playUntilDecided,
  revealHands,
  seatPair,
  waitUntil,
  writeGolden,
} from "./e2e-harness";

const MATCH_ID = "m-g1-g2";

let server: ColyseusTestServer;
let match: SeatedMatch;

// La partida se juega UNA vez, en el hook, y los cuatro `it` afirman sobre lo que quedó.
// Jugarla dentro del primero ataría a los otros tres a su orden: `vitest -t "historial"`
// correría solo y leería un historial vacío, y una caída del primero se manifestaría como
// tres fallos más que no señalan la causa.
beforeAll(async () => {
  server = await bootServer(2586);
  match = await seatPair(server, ["g1", "g2"], "seed-partida-completa");
  await revealHands(match);

  await playUntilDecided(match);
  // Y SE ESPERA AL TERMINAL: el golden captura el árbol APAGADO, no el de la ventana de
  // revancha. Desde que la ventana existe, «se dejó de jugar» y «se terminó» son dos momentos
  // distintos, y el que este fixture congela es el segundo.
  await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);

  // El golden se captura ACÁ y no dentro de un `it`: es el único punto donde el árbol
  // final y su historial están los dos completos y en alcance, y desde la Tarea 20 jugar
  // la partida ya no pertenece a ningún test en particular. En una corrida normal es
  // no-op — solo escribe con WRITE_GOLDEN=1.
  await writeGolden("golden-2p", match);
}, 30_000);

afterAll(async () => {
  await server.shutdown();
});

describe("partida 2P completa", () => {
  it("se jugó de punta a punta hasta que hubo veredicto", async () => {
    expect(match.serverState.phase).toBe("FINISHED");
    const scoreboard = match.serverState.scoreboard;
    expect(scoreboard).toBeDefined();
    expect(Math.max(scoreboard?.teamA ?? 0, scoreboard?.teamB ?? 0)).toBeGreaterThanOrEqual(
      match.serverState.pointsToWin,
    );
    expect(match.serverState.pastRounds.length).toBeGreaterThan(0);
  });

  it("el historial de esa partida cierra con el veredicto y sin huecos de seq", async () => {
    const entries = await historyOf(MATCH_ID);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1));
    // EL VEREDICTO NO ES LA ÚLTIMA LÍNEA, y desde la revancha faltan DOS y no una:
    // `MATCH_RESOLVED` abre la presentación de la partida, al vencer ésa se abre la ventana
    // de revancha, y al vencer la ventana se apaga la mesa. Afirmar solo sobre `at(-1)`
    // diría que el registro se corta antes del apagado, que es justo el hueco que el
    // historial existe para no dejar.
    //
    // Los dos vencimientos se distinguen por su `kind` —`PRESENTING_MATCH` y
    // `REMATCH_WINDOW`—, y por eso se asierta: sin eso, borrar la ventana de revancha
    // dejaría este test verde con una línea menos.
    expect(entries.slice(-3).map((entry) => entry.type)).toEqual([
      "MATCH_RESOLVED",
      "DEADLINE_EXPIRED",
      "DEADLINE_EXPIRED",
    ]);
    expect(entries.slice(-2).map((entry) => (entry.payload as { kind?: string }).kind)).toEqual([
      "PRESENTING_MATCH",
      "REMATCH_WINDOW",
    ]);
  });

  it("cada DEADLINE_EXPIRED quedó registrado como evento del sistema", async () => {
    const entries = await historyOf(MATCH_ID);
    const expirations = entries.filter((entry) => entry.type === "DEADLINE_EXPIRED");
    expect(expirations.length).toBeGreaterThan(0);

    entries.forEach((entry, index) => {
      if (entry.type !== "DEADLINE_EXPIRED") return;
      expect(entry.source).toBe("SYSTEM");
      expect(entry.kind).toBe("EVENT");
      // ESTA RAMA NO SE EJERCE ACÁ, y el título del test no la promete. La relación
      // existe en producción —`MatchDriver.timeout()` con `kind === "TURN"` retira al
      // que no jugó y emite el ABANDON del sistema (match/driver.ts:70-80)—, pero en una
      // corrida sana de este E2E el bot juega siempre a tiempo y NINGÚN plazo de turno
      // vence: los vencimientos reales de esta partida son 6 PRESENTING_ROUND y 1
      // PRESENTING_MATCH, cero TURN. Queda como red por si el bot se atrasa; la
      // cobertura de verdad de ese camino es la Tarea 22, con un jugador que se cuelga
      // a propósito. Los de las presentaciones no ejecutan verbo ninguno —arrancan la
      // ronda siguiente o apagan la mesa—, así que exigirles uno sería inventar el
      // contrato en vez de medirlo.
      if (entry.payload.kind !== "TURN") return;
      const next = entries[index + 1];
      expect(next?.source).toBe("SYSTEM");
      expect(next?.type).toBe("ABANDON");
    });
  });

  it("ningún comando quedó registrado con source SYSTEM ni al revés", async () => {
    const entries = await historyOf(MATCH_ID);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      if (entry.kind === "COMMAND") expect(entry.source).toBe("PLAYER");
      if (entry.kind === "EVENT") expect(entry.source).toBe("SYSTEM");
    }
  });
});
