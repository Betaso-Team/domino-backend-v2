import { describe, expect, it } from "vitest";
import type { MatchState } from "../../state";
import { engineWithHands } from "./build-engine";

// LOS INVARIANTES DE LA MÁQUINA, y son tres frases del producto que hasta acá SALÍAN de una
// guarda sin estar afirmadas en ningún lado:
//
//   1. UNA SOLA MÁQUINA POR EQUIPO. Nunca dos.
//   2. UN EQUIPO DE PURAS MÁQUINAS NO JUEGA. Si los dos humanos de un bando se van, la mesa se
//      cierra en vez de enfrentar a alguien contra un equipo que no tiene a nadie.
//   3. NUNCA MÁQUINAS CONTRA MÁQUINAS. Mientras la partida siga en juego tiene que quedar al
//      menos un humano en CADA bando.
//
// ⚠ NO SE MIDEN CON UN CASO ELEGIDO A MANO, y ésa es la diferencia con `bot-seating.int.test.ts`:
// allá cada `it` fija UNA decisión, y un caso que nadie pensó se cuela igual. Acá se recorren
// TODAS las secuencias de retiro posibles de una mesa de cuatro —64 caminos— y el invariante se
// comprueba después de CADA paso. Es la única forma de afirmar «nunca» en vez de «no en estos
// cuatro casos».

const SEATS = ["u1", "u2", "u3", "u4"] as const;

// Con `SEAT_ORDER` las parejas son las de los asientos: u1+u3 = A, u2+u4 = B.
const fourSeats = () =>
  engineWithHands(
    {
      u1: [
        [6, 6],
        [4, 3],
      ],
      u2: [
        [6, 1],
        [2, 0],
      ],
      u3: [
        [1, 1],
        [5, 2],
      ],
      u4: [
        [3, 0],
        [5, 5],
      ],
    },
    [],
    { enableBots: true },
  );

const humansIn = (match: MatchState, teamId: string) =>
  match.players.filter(
    (player) => player.teamId === teamId && !player.isBot && !player.hasAbandoned,
  ).length;

const botsIn = (match: MatchState, teamId: string) =>
  match.players.filter((player) => player.teamId === teamId && player.isBot).length;

/** El invariante entero, en un lugar. Se corre después de cada retiro de cada secuencia. */
function assertInvariants(match: MatchState, trace: readonly string[]): void {
  const context = `tras ${trace.join(" → ")}`;

  for (const teamId of ["A", "B"]) {
    // 1. UNA SOLA MÁQUINA POR EQUIPO.
    expect(
      botsIn(match, teamId),
      `${context}: ${teamId} tiene más de una máquina`,
    ).toBeLessThanOrEqual(1);
  }

  if (match.phase !== "PLAYING") return;

  for (const teamId of ["A", "B"]) {
    // 2 y 3. CON LA PARTIDA EN JUEGO, cada bando tiene que tener a alguien de carne y hueso.
    // Esto cubre las dos frases a la vez: un equipo de puras máquinas no puede estar jugando, y
    // por lo tanto tampoco puede haber máquinas contra máquinas.
    expect(
      humansIn(match, teamId),
      `${context}: ${teamId} juega sin ningún humano`,
    ).toBeGreaterThan(0);
  }
}

/** Todas las secuencias de retiro: cada subconjunto ordenado de los cuatro asientos. */
function sequences(): string[][] {
  const all: string[][] = [];
  const walk = (current: string[], left: readonly string[]) => {
    if (current.length > 0) all.push([...current]);
    for (const seat of left) {
      walk(
        [...current, seat],
        left.filter((other) => other !== seat),
      );
    }
  };
  walk([], SEATS);
  return all;
}

describe("los invariantes de la máquina, sobre TODAS las secuencias de retiro", () => {
  const paths = sequences();

  it("recorre las 64 secuencias posibles", () => {
    expect(paths).toHaveLength(64);
  });

  it.each(paths.map((path) => [path.join(","), path] as const))(
    "se sostienen retirándose %s",
    (_name, path) => {
      const e = fourSeats();
      e.start();
      const trace: string[] = [];

      for (const seat of path) {
        // La partida ya cerrada no acepta más retiros, y eso no es parte de lo que se mide: el
        // invariante tiene que valer en el estado en el que la mesa quedó.
        if (e.match.phase !== "PLAYING") break;
        e.abandon(seat);
        trace.push(seat);
        assertInvariants(e.match, trace);
      }
    },
  );
});

describe("los tres finales que la regla produce", () => {
  // UNO POR EQUIPO ES EL TECHO, y es el único caso en el que la mesa sigue con máquinas.
  it("una máquina por bando: la mesa sigue", () => {
    const e = fourSeats();
    e.start();

    e.abandon("u1");
    e.abandon("u2");

    expect(botsIn(e.match, "A")).toBe(1);
    expect(botsIn(e.match, "B")).toBe(1);
    expect(humansIn(e.match, "A")).toBe(1);
    expect(humansIn(e.match, "B")).toBe(1);
    expect(e.match.phase).toBe("PLAYING");
  });

  // ⚠ EL SEGUNDO DE UN MISMO EQUIPO NO DEJA OTRA MÁQUINA: cierra la partida. Sin esto quedaría un
  // bando de puras máquinas enfrentando a personas — y podría GANAR, con el premio yendo a un
  // equipo donde nadie cobra.
  it("los dos del mismo bando: la partida se cierra y no quedan dos máquinas", () => {
    const e = fourSeats();
    e.start();

    e.abandon("u1");
    e.abandon("u3");

    expect(botsIn(e.match, "A")).toBe(1);
    expect(humansIn(e.match, "A")).toBe(0);
    expect(e.match.phase).not.toBe("PLAYING");
  });

  // Y NUNCA SE LLEGA A MÁQUINAS CONTRA MÁQUINAS: para eso harían falta dos por bando, y el
  // segundo de cada bando ya cerró la mesa antes.
  it("no existe el camino a cuatro máquinas", () => {
    const e = fourSeats();
    e.start();

    for (const seat of SEATS) {
      if (e.match.phase !== "PLAYING") break;
      e.abandon(seat);
    }

    expect(botsIn(e.match, "A") + botsIn(e.match, "B")).toBeLessThanOrEqual(2);
    expect(e.match.phase).not.toBe("PLAYING");
  });
});
