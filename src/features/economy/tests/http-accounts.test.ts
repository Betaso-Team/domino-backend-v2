import { type Server, createServer } from "node:http";
import { HttpClient } from "@/shared/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountUnavailableError } from "../accounts";
import { HttpAccountDirectory } from "../transports/http-accounts";

// The adapter that replaces the direct database access v1 had. What has to be right is WHICH
// credential the question carries.
describe("HttpAccountDirectory (contrato con el backend principal)", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ url: string; authorization?: string }>;
  let respond: () => { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
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

  beforeEach(() => {
    clock = 1000;
    requests = [];
    respond = () => ({
      status: 200,
      body: { currency: "VES", user: { username: "gabriel", profilePicture: "pic.png" } },
    });
  });

  // The clock is injectable so the cache can be expired without waiting five minutes.
  let clock = 1000;
  const build = (ttlMs = 5 * 60_000) =>
    new HttpAccountDirectory(new HttpClient({ baseUrl }), () => clock, ttlMs);

  it("pregunta con el token DEL JUGADOR, no con la api key del servidor", async () => {
    const account = await build().accountOf("u1", "token-de-u1");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/my-profile");
    // The question is "what is MY account?", not "what is this id's?" — which the truco has no
    // business being able to ask about anyone.
    expect(requests[0]?.authorization).toBe("Bearer token-de-u1");
    expect(account).toEqual({ currency: "VES", username: "gabriel", profilePicture: "pic.png" });
  });

  it("cachea: el cobro y el premio no vuelven a preguntar lo que resolvió la puerta", async () => {
    const accounts = build();
    await accounts.accountOf("u1", "token-de-u1");

    // With no token, which is how the charge and the prize arrive.
    const again = await accounts.accountOf("u1");

    expect(requests).toHaveLength(1);
    expect(again.currency).toBe("VES");
  });

  // The expiry is NOT what upholds "you are paid in the currency you entered with" — that rule lives
  // in `MatchAccounts`, which freezes per match. Here it only avoids asking again and, above all,
  // keeps the map from growing forever and a currency change from going unseen until the next deploy.
  it("vencida la cache, vuelve a preguntar", async () => {
    const accounts = build();
    await accounts.accountOf("u1", "token-de-u1");
    clock += 5 * 60_000 + 1;

    await accounts.accountOf("u1", "token-de-u1");

    expect(requests).toHaveLength(2);
  });

  it("sin token y con la cache vencida no inventa una cuenta", async () => {
    const accounts = build();
    await accounts.accountOf("u1", "token-de-u1");
    clock += 5 * 60_000 + 1;

    await expect(accounts.accountOf("u1")).rejects.toBeInstanceOf(AccountUnavailableError);
  });

  it("dos preguntas simultáneas comparten una sola petición", async () => {
    const accounts = build();

    await Promise.all([accounts.accountOf("u1", "t"), accounts.accountOf("u1", "t")]);

    expect(requests).toHaveLength(1);
  });

  // With no token and nothing cached there is nobody to ask. Failing is correct: guessing a currency
  // is charging wrong, and it also means somebody asked before the door had resolved it.
  it("sin token y sin cache falla, en vez de inventar una moneda", async () => {
    await expect(build().accountOf("u1")).rejects.toBeInstanceOf(AccountUnavailableError);
    expect(requests).toHaveLength(0);
  });

  it("una moneda desconocida es un fallo, no un default", async () => {
    respond = () => ({ status: 200, body: { currency: "EUR", user: { username: "g" } } });

    await expect(build().accountOf("u1", "t")).rejects.toBeInstanceOf(AccountUnavailableError);
  });

  // The name and the picture DO degrade: a prize with no picture is paid all the same. The currency
  // does not, because without it there is no conversion.
  it("sin nombre ni foto sigue resolviendo: eso no impide pagar", async () => {
    respond = () => ({ status: 200, body: { currency: "USD" } });

    expect(await build().accountOf("u1", "t")).toEqual({
      currency: "USD",
      username: "",
      profilePicture: "",
    });
  });

  it("un error del backend no se cachea: la próxima vuelve a intentar", async () => {
    respond = () => ({ status: 500, body: { message: "nope" } });
    const accounts = build();
    await expect(accounts.accountOf("u1", "t")).rejects.toBeInstanceOf(AccountUnavailableError);

    respond = () => ({ status: 200, body: { currency: "USD", user: { username: "g" } } });
    expect((await accounts.accountOf("u1", "t")).currency).toBe("USD");
    expect(requests).toHaveLength(2);
  });
});
