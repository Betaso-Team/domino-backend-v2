import { rootContainer } from "@/di-container";
import type { StrikeBook } from "@/features/tournament";
import { bootTestServer, mintToken } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The player's own walkout penalty, which until now had no way out towards the client: the only thing
// that reached it was a `PENALIZED` after pressing search, with nothing in it.
//
// Seeded through the real `StrikeBook` and not by writing keys: what is being pinned is that the
// endpoint answers what the DOOR of the queue reads, and going around the book would let the two
// drift without the test noticing.
describe("endpoint GET /me/tournaments/:tournamentId/penalty (integración)", () => {
  let server: ColyseusTestServer;
  let strikes: StrikeBook;

  const TOURNAMENT = "t1";
  const asPlayer = (userId: string) => ({
    headers: { authorization: `Bearer ${mintToken(userId)}` },
  });
  const penalty = (userId: string, tournamentId = TOURNAMENT) =>
    server.http.get(`/me/tournaments/${tournamentId}/penalty`, asPlayer(userId));

  beforeAll(async () => {
    server = await bootTestServer(2597);
    strikes = rootContainer.resolve<StrikeBook>("StrikeBook");
  });
  afterAll(async () => {
    await server.shutdown();
  });
  // CADA `it` USA UN JUGADOR DISTINTO, y eso reemplaza al almacén nuevo por test que usa truco.
  // Acá no hay `installFakeBackend` que sustituir: sin `REDIS_URL` —que `vitest.setup.ts` borra— el
  // container ya arma el `StrikeBook` sobre el almacén de memoria, así que el libro y el endpoint
  // son el mismo store por construcción, que es la mitad de lo que este archivo afirma.
  //
  // Lo que sí se pierde al no poder cambiarlo es el aislamiento entre `it`, y por eso los nombres
  // no se repiten: un `limpio` reutilizado arrastraría los strikes del test anterior.

  it("sin ningún abandono, cero strikes y sin bloqueo", async () => {
    const res = await penalty("limpio");

    expect(res.data).toEqual({ strikes: 0, penalizedUntil: null });
  });

  // The first walkout is only WRITTEN DOWN — it can be a real disconnection — so the client has to be
  // able to show "one so far" without showing a countdown that does not exist.
  it("con un abandono, cuenta el strike pero no penaliza", async () => {
    await strikes.add(TOURNAMENT, "uno");

    const res = await penalty("uno");

    expect(res.data).toEqual({ strikes: 1, penalizedUntil: null });
  });

  it("con dos, devuelve hasta cuándo, en ISO", async () => {
    await strikes.add(TOURNAMENT, "dos");
    await strikes.add(TOURNAMENT, "dos");

    const res = await penalty("dos");

    expect(res.data.strikes).toBe(2);
    expect(Date.parse(res.data.penalizedUntil as string)).toBeGreaterThan(Date.now());
  });

  // The penalty is PER TOURNAMENT, and the key carries both halves. Without this, one walkout would
  // lock a player out of every tournament at once.
  it("lo que se debe en un torneo no se debe en otro", async () => {
    await strikes.add(TOURNAMENT, "viajero");
    await strikes.add(TOURNAMENT, "viajero");

    expect((await penalty("viajero", "otro-torneo")).data).toEqual({
      strikes: 0,
      penalizedUntil: null,
    });
  });

  // THE SUBJECT of the answer is the bearer, which is what makes any further authorisation
  // unnecessary: there is no way to ask about somebody else.
  it("cada uno recibe lo suyo, no lo del otro", async () => {
    await strikes.add(TOURNAMENT, "el-que-abandonó");

    expect((await penalty("el-que-no")).data).toEqual({ strikes: 0, penalizedUntil: null });
  });

  describe("la credencial", () => {
    it("sin Authorization es 401", async () => {
      await expect(server.http.get(`/me/tournaments/${TOURNAMENT}/penalty`)).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it("con un token que no firmamos nosotros, también", async () => {
      await expect(
        server.http.get(`/me/tournaments/${TOURNAMENT}/penalty`, {
          headers: { authorization: "Bearer no.es.un.token" },
        }),
      ).rejects.toMatchObject({ statusCode: 401 });
    });
  });
});
