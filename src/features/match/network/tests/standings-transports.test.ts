import type { AmqpDelivery } from "@/shared/amqp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmqpRankingFeed } from "../transports/amqp-ranking";
import { HttpLeagueFeed } from "../transports/http-leagues";

// LOS DOS CONTRATOS, CAMPO POR CAMPO. Es lo único que estos dos archivos hacen —traducir— y lo
// único que nadie de este lado puede verificar corriendo: del otro lado hay un consumidor de v1
// que espera nombres exactos, y un nombre que no coincide falla en SILENCIO. Por eso se asserta el
// cuerpo completo con `toEqual` y no campo por campo: una clave de más también es una traducción
// equivocada.

interface Sent {
  readonly queue: string;
  readonly pattern: string;
  readonly data: unknown;
}

function fakePublisher(): { readonly sent: Sent[]; readonly port: AmqpDelivery } {
  const sent: Sent[] = [];
  return {
    sent,
    port: {
      async publishPattern(queue, pattern, data) {
        sent.push({ queue, pattern, data });
      },
      async publishTopic(): Promise<void> {
        throw new Error("el ranking va a una cola, no a un exchange");
      },
    },
  };
}

const entry = {
  userId: "uuid-1",
  username: "gana",
  profilePicture: "foto.png",
  currency: "VES",
  multiplier: 5,
  opponentIds: ["uuid-2"],
};

describe("AmqpRankingFeed", () => {
  it("publica a la cola de v1 con el patrón de NestJS", async () => {
    const { sent, port } = fakePublisher();
    await new AmqpRankingFeed(port).won(entry);

    // Los dos nombres son de v1 y no se inventan: `rankings_queue` y `ranking.save-participation`.
    expect(sent[0]?.queue).toBe("rankings_queue");
    expect(sent[0]?.pattern).toBe("ranking.save-participation");
  });

  it("traduce userId a userId y no manda el aumento si no hubo", async () => {
    const { sent, port } = fakePublisher();
    await new AmqpRankingFeed(port).won(entry);

    expect(sent[0]?.data).toEqual({
      rankingType: "domino-ranking",
      currency: "VES",
      userId: "uuid-1",
      username: "gana",
      profilePicture: "foto.png",
      multiplier: 5,
      opponentIds: ["uuid-2"],
    });
  });

  it("con aumento suma la traza y nada más", async () => {
    const { sent, port } = fakePublisher();
    const betIncrease = { level: 2, extra: 2, baseMultiplier: 3 };
    await new AmqpRankingFeed(port).won({ ...entry, betIncrease });

    expect(sent[0]?.data).toMatchObject({ multiplier: 5, betIncrease });
  });
});

describe("HttpLeagueFeed", () => {
  afterEach(() => vi.unstubAllGlobals());

  const result = {
    winner: { userId: "uuid-1", username: "gana", profilePicture: "foto.png" },
    losers: [{ userId: "uuid-2", username: "pierde", profilePicture: null }],
  };

  function stubFetch(status = 200) {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status });
    });
    return calls;
  }

  it("postea a leagues/save con el nombre de la liga del dominó", async () => {
    const calls = stubFetch();
    await new HttpLeagueFeed("https://api.betaso.test/api/").record(result);

    expect(calls[0]?.url).toBe("https://api.betaso.test/api/leagues/save");
    expect(calls[0]?.body).toEqual({
      leagueName: "Domino",
      users: {
        winner: { id: "uuid-1", username: "gana", profilePicture: "foto.png" },
        // `loosers` CON DOS O. Es el nombre del campo de v1 y corregirlo deja a la liga sin los
        // perdedores, así que el test lo fija: es lo único que impide que alguien lo "arregle".
        loosers: [{ id: "uuid-2", username: "pierde", profilePicture: null }],
      },
    });
  });

  // Las dos formas existen en los `.env` de v1, y `${base}leagues/save` contra
  // `${base}/leagues/save` son dos rutas distintas — una de ellas 404.
  it("normaliza la base venga con barra final o sin ella", async () => {
    const calls = stubFetch();
    await new HttpLeagueFeed("https://api.betaso.test/api").record(result);
    expect(calls[0]?.url).toBe("https://api.betaso.test/api/leagues/save");
  });

  // `fetch` SOLO rechaza por fallo de RED, así que sin mirar el estado un 500 resolvería como
  // éxito y el log del listener diría que la liga recibió lo que no recibió.
  it("un estado de error rechaza en vez de resolver", async () => {
    stubFetch(500);
    await expect(new HttpLeagueFeed("https://api.betaso.test/api/").record(result)).rejects.toThrow(
      /HTTP 500/,
    );
  });
});
