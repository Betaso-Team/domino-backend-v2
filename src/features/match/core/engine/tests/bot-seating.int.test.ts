import { describe, expect, it } from "vitest";
import { currentTurnOf, playerOf } from "../state-projections";
import { engineWithHands } from "./build-engine";

// SENTAR LA MÁQUINA. Lo que se mide es la DECISIÓN —sigue la mesa o se cierra la partida— y no la
// ficha que el bot elige, que es de `rules/bot.ts` y se prueba sin motor.
//
// Los dos caminos que retiran a un asiento entran acá: el verbo `ABANDON` y el reloj del turno.
// Que se comporten igual es la mitad de lo que este archivo fija.

// La mesa de cuatro del arnés: con `SEAT_ORDER` las parejas son u1+u3 contra u2+u4.
const fourSeats = (options: { enableBots: boolean }) =>
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
    options,
  );

describe("el que se va de una mesa de cuatro", () => {
  it("deja una máquina en su asiento y la partida sigue", () => {
    const e = fourSeats({ enableBots: true });
    e.start();

    const events = e.abandon("u2");

    expect(events).toEqual([{ type: "BOT_SEATED", playerId: "u2" }]);
    expect(playerOf("u2", e.match).isBot).toBe(true);
    expect(e.match.phase).toBe("PLAYING");
  });

  // ⚠ NO SE MARCA `hasAbandoned`, Y ES LA MITAD QUE DECIDE EL FINAL. Las dos banderas dicen «acá
  // ya no hay nadie» y llevan a lados opuestos: con el retiro puesto, `MatchReferee` ve un equipo
  // entero fuera y corona al otro — o sea que la mesa que el bot vino a salvar termina igual, por
  // forfeit, con una máquina jugándola.
  it("no lo marca como retirado", () => {
    const e = fourSeats({ enableBots: true });
    e.start();

    e.abandon("u2");

    expect(playerOf("u2", e.match).hasAbandoned).toBe(false);
  });

  // El reloj del turno llega al mismo lugar, y además emite lo suyo: el `DEADLINE_EXPIRED` que
  // dice qué venció. Lo que NO emite es `ABANDON`, porque nadie abandonó.
  it("el turno vencido también sienta la máquina, sin decir que abandonó", () => {
    const e = fourSeats({ enableBots: true });
    e.start();

    const events = e.fireTimeout();

    expect(events).toEqual([
      { type: "DEADLINE_EXPIRED", kind: "TURN" },
      { type: "BOT_SEATED", playerId: "u1" },
    ]);
    expect(playerOf("u1", e.match).isBot).toBe(true);
  });

  // ⚠ EL TURNO QUE LA MÁQUINA HEREDA VIENE VENCIDO por ese camino, así que hay que devolverle el
  // reloj. Sin esto el próximo vencimiento la retira —ahora sí de verdad, porque a un bot ya no se
  // lo reemplaza por otro— y la mesa dura exactamente un tick más que sin bots.
  it("le devuelve el reloj al turno que hereda", () => {
    const e = fourSeats({ enableBots: true });
    e.start();
    e.clockBox.now += 600;

    e.fireTimeout();

    expect(currentTurnOf(e.round()).playerId).toBe("u1");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 600);
  });

  // Y el turno de OTRO no se toca: retirarse no es privilegio de quien juega, y el que se va a
  // mitad del turno ajeno no puede reiniciarle el reloj al que está pensando.
  it("no le reinicia el reloj al que está pensando", () => {
    const e = fourSeats({ enableBots: true });
    e.start();
    const before = e.match.activeDeadline;
    e.clockBox.now += 200;

    e.abandon("u2");

    expect(currentTurnOf(e.round()).playerId).toBe("u1");
    expect(e.match.activeDeadline).toBe(before);
  });
});

describe("cuándo NO se sienta una máquina", () => {
  // LA MESA TIENE QUE OFRECERLO. Sin eso el retiro es el de siempre y la partida se cierra.
  it("el modo que no los habilita retira como antes", () => {
    const e = fourSeats({ enableBots: false });
    e.start();

    e.abandon("u2");

    expect(playerOf("u2", e.match).isBot).toBe(false);
    expect(playerOf("u2", e.match).hasAbandoned).toBe(true);
  });

  // ⚠ ESTO ES LO QUE APAGA EL 2P, y sin un chequeo del tamaño de la mesa: con un jugador por
  // bando, el equipo del que se va queda vacío, así que no hay compañero a quien proteger. Es la
  // prohibición que v1 declara aparte (`enableBots` no puede ir en un modo de dos) saliendo de la
  // regla del equipo en vez de ser un segundo chequeo que puede contradecirla.
  it("en una mesa de dos no se sienta ninguna, aunque el modo lo permita", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 1]] }, [], { enableBots: true });
    e.start();

    e.abandon("u2");

    expect(playerOf("u2", e.match).isBot).toBe(false);
    expect(playerOf("u2", e.match).hasAbandoned).toBe(true);
    expect(e.match.phase).toBe("PRESENTING_MATCH");
  });

  // EL SEGUNDO DEL MISMO EQUIPO YA NO TIENE A QUIÉN PROTEGER: su compañero es la máquina que se
  // sentó cuando se fue el primero, y un bot no es alguien a quien salvarle la partida.
  it("el segundo del mismo equipo cierra la partida", () => {
    const e = fourSeats({ enableBots: true });
    e.start();
    e.abandon("u2");

    e.abandon("u4");

    expect(playerOf("u4", e.match).isBot).toBe(false);
    expect(playerOf("u4", e.match).hasAbandoned).toBe(true);
    expect(e.match.phase).toBe("PRESENTING_MATCH");
  });

  // Y uno de cada equipo SÍ deja dos máquinas: cada una protege al compañero que quedó.
  it("uno de cada equipo deja dos máquinas y la mesa sigue", () => {
    const e = fourSeats({ enableBots: true });
    e.start();

    e.abandon("u2");
    e.abandon("u3");

    expect(playerOf("u2", e.match).isBot).toBe(true);
    expect(playerOf("u3", e.match).isBot).toBe(true);
    expect(e.match.phase).toBe("PLAYING");
  });
});
