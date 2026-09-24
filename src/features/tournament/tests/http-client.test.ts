import { type Server, createServer } from "node:http";
import { HttpClient } from "@/shared/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TournamentUnavailableError } from "../client";
import { DEFAULT_TOURNAMENT_CONFIG } from "../config";
import { HttpTournamentClient } from "../transports/http-client";

// A CONTRACT test: the adapter against a real server. What is tested is what travels on the wire —
// the URL and the credential — and what is understood of what comes back, because the tournament's
// document does NOT carry two of the three things matchmaking needs and they have to be derived.
describe("HttpTournamentClient (contrato con el backend principal)", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ url: string; authorization?: string; apiKey?: string }>;
  let respond: () => { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        apiKey: req.headers["x-internal-api-key"] as string | undefined,
      });
      const { status, body } = respond();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("sin puerto");
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  const CHAMPIONSHIP = {
    name: "Torneo de los martes",
    status: "in_game",
    gameConfig: { game: "domino", modality: "1vs1" },
    scoringConfig: { pointsPerWin: 3, pointsPerDraw: 0, pointsPerLoss: 1 },
  };

  beforeEach(() => {
    requests = [];
    respond = () => ({ status: 200, body: CHAMPIONSHIP });
  });

  const build = () =>
    new HttpTournamentClient(
      new HttpClient({ baseUrl }),
      { value: "la-api-key" },
      DEFAULT_TOURNAMENT_CONFIG,
    );

  describe("infoOf", () => {
    it("pregunta con la API KEY del servidor: es el truco preguntando, no un jugador", async () => {
      await build().infoOf("t1");

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/championship/championships/t1");
      expect(requests[0]?.apiKey).toBe("la-api-key");
      expect(requests[0]?.authorization).toBeUndefined();
    });

    it("traduce el estado, que del otro lado viene en minúsculas", async () => {
      expect((await build().infoOf("t1")).status).toBe("IN_GAME");
    });

    it("los asientos salen de la MODALIDAD, que es el único campo que lo dice", async () => {
      expect((await build().infoOf("t1")).playersQuantity).toBe(2);

      respond = () => ({
        status: 200,
        body: { ...CHAMPIONSHIP, gameConfig: { modality: "2vs2" } },
      });
      const parejas = await build().infoOf("t1");
      expect(parejas.playersQuantity).toBe(4);
      // And with the seats the target score changes, which does not come from the tournament either.
      expect(parejas.pointsToWin).toBe(24);
    });

    it("una modalidad que no es truco NO se juega: el torneo existe, este servidor no lo hospeda", async () => {
      respond = () => ({
        status: 200,
        body: { ...CHAMPIONSHIP, gameConfig: { modality: "allvsall" } },
      });

      await expect(build().infoOf("t1")).rejects.toBeInstanceOf(TournamentUnavailableError);
    });

    it("lo del perdedor sí sale del torneo, y sin él simplemente no suma", async () => {
      expect((await build().infoOf("t1")).pointsPerLoss).toBe(1);

      respond = () => ({ status: 200, body: { ...CHAMPIONSHIP, scoringConfig: undefined } });
      expect((await build().infoOf("t1")).pointsPerLoss).toBe(0);
    });

    it("un torneo que no existe no se degrada a `null` como en v1: se dice", async () => {
      respond = () => ({ status: 404, body: { message: "no existe" } });

      await expect(build().infoOf("t1")).rejects.toBeInstanceOf(TournamentUnavailableError);
    });
  });

  describe("isEnrolled", () => {
    it("pregunta con el token DEL JUGADOR: la autorización es suya, no del servidor", async () => {
      respond = () => ({ status: 200, body: { enrolled: true } });

      expect(await build().isEnrolled("t1", "token-de-u1")).toBe(true);
      expect(requests[0]?.url).toBe("/championship/championships/t1/is-enrolled");
      expect(requests[0]?.authorization).toBe("Bearer token-de-u1");
      expect(requests[0]?.apiKey).toBeUndefined();
    });

    it("no inscrito es una respuesta, y se contesta que no", async () => {
      respond = () => ({ status: 200, body: { enrolled: false } });

      expect(await build().isEnrolled("t1", "token-de-u1")).toBe(false);
    });

    // It is told apart from "not enrolled" because the consequences differ: one invites coming back,
    // the other does not.
    it('que el backend no conteste NO es un "no está inscrito"', async () => {
      respond = () => ({ status: 503, body: {} });

      await expect(build().isEnrolled("t1", "token-de-u1")).rejects.toBeInstanceOf(
        TournamentUnavailableError,
      );
    });
  });
});
