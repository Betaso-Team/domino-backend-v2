import { type Server, createServer } from "node:http";
import { FakeAccountDirectory, FakeRateBook } from "@/features/economy/tests/fake-accounts";
import { HttpClient } from "@/shared/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MatchAccounts } from "../match-accounts";
import { MatchRates } from "../match-rates";
import { toCents } from "../rates";
import { HttpWallet } from "../transports/http-wallet";
import { InsufficientFundsError, WalletUnavailableError } from "../wallet";

// CONTRACT tests: the adapter against a real server and not against a faked HTTP layer. What is
// tested is what travels on the wire — the URL, the headers, the body, the status — because that is
// exactly what has to be right for the main backend to understand. Faking the HTTP layer would prove
// we call it, which is not the risk.

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

describe("HttpWallet (contrato con el backend principal)", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Recorded[];
  // Each test decides what the backend answers. By default: plenty of balance and the charge accepted.
  let respond: (req: Recorded) => { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const recorded: Recorded = {
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers as Record<string, string | undefined>,
          body: raw.length > 0 ? JSON.parse(raw) : undefined,
        };
        requests.push(recorded);
        const { status, body } = respond(recorded);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
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
    requests = [];
    respond = ({ url }) =>
      url.includes("my-balance") ? { status: 200, body: 1_000_000 } : { status: 200, body: null };
  });

  const build = (opts: { currency?: "USD" | "VES"; rate?: number } = {}) => {
    const accounts = new FakeAccountDirectory();
    if (opts.currency) accounts.setAccount("u1", { currency: opts.currency });
    const rates = new FakeRateBook(opts.rate ?? 1);
    return new HttpWallet({
      http: new HttpClient({ baseUrl }),
      apiKey: { value: "la-api-key" },
      accounts,
      matchAccounts: new MatchAccounts(accounts),
      rates,
      matchRates: new MatchRates(rates),
    });
  };

  describe("canAfford", () => {
    it("pregunta el saldo en la moneda del jugador, CON la api key de servidor", async () => {
      await build({ currency: "VES" }).canAfford({
        playerId: "u1",
        amount: 1,
        token: "token-de-u1",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("GET");
      expect(requests[0]?.url).toContain("wallets/my-balance-microservice");
      expect(requests[0]?.url).toContain("currency=VES");
      expect(requests[0]?.url).toContain("userId=u1");
      // The balance is asked about AS THE TRUCO and not on the player's behalf: the server credential.
      expect(requests[0]?.headers["x-internal-api-key"]).toBe("la-api-key");
    });

    it("compara contra el monto convertido a centavos, no contra la unidad de cuenta", async () => {
      // One account unit at a rate of 40 is 4000 cents. 3999 does not cover it; 4000 does.
      respond = () => ({ status: 200, body: 3_999 });
      expect(
        await build({ currency: "VES", rate: 40 }).canAfford({
          playerId: "u1",
          amount: 1,
          token: "t",
        }),
      ).toBe(false);

      respond = () => ({ status: 200, body: 4_000 });
      expect(
        await build({ currency: "VES", rate: 40 }).canAfford({
          playerId: "u1",
          amount: 1,
          token: "t",
        }),
      ).toBe(true);
    });

    it('un saldo que no es número es "no se pudo", nunca "no le alcanza"', async () => {
      respond = () => ({ status: 200, body: { balance: 100 } });

      await expect(
        build().canAfford({ playerId: "u1", amount: 1, token: "t" }),
      ).rejects.toBeInstanceOf(WalletUnavailableError);
    });
  });

  describe("charge", () => {
    const entry = { matchId: "room-1", playerId: "u1", amount: 1, reason: "ENTRY_FEE" as const };

    it("manda el cuerpo que el backend espera, con los centavos y su vocabulario", async () => {
      await build({ currency: "VES", rate: 40 }).charge(entry);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("/wallet-movements/betaso-game-movement");
      expect(requests[0]?.body).toEqual({
        userId: "u1",
        amount: 4_000,
        transactionType: "cut",
        // The room identifier the other side deduplicates by.
        tokenId: "room-1",
        currency: "VES",
        gameMovementType: "domino",
        reason: "entry_fee",
      });
    });

    it("el multiplicador tiene su propia razón, que es media clave de idempotencia", async () => {
      await build().charge({ ...entry, reason: "BET_MULTIPLIER" });

      expect((requests[0]?.body as { reason: string }).reason).toBe("bet_multiplier");
    });

    // A 400 from this endpoint is how it says "they cannot afford it": an ANSWER, and whoever charges
    // decides what to do with it. Confusing it with a network failure would let in someone who cannot
    // pay.
    it("un 400 es saldo insuficiente", async () => {
      respond = () => ({ status: 400, body: { message: "InsufficientFunds" } });

      await expect(build().charge(entry)).rejects.toBeInstanceOf(InsufficientFundsError);
    });

    it('cualquier otro error es "no se pudo cobrar", que es otra cosa', async () => {
      respond = () => ({ status: 503, body: { message: "nope" } });

      await expect(build().charge(entry)).rejects.toBeInstanceOf(WalletUnavailableError);
    });

    // The rate is frozen per (match, currency): the second charge of the same match uses the first's
    // even if the market moved. It is what makes the prize add up.
    it("el segundo cobro de una partida usa la tasa que congeló el primero", async () => {
      const rates = new FakeRateBook(40);
      const accounts = new FakeAccountDirectory("VES");
      const wallet = new HttpWallet({
        http: new HttpClient({ baseUrl }),
        apiKey: { value: "k" },
        accounts,
        matchAccounts: new MatchAccounts(accounts),
        rates,
        matchRates: new MatchRates(rates),
      });

      await wallet.charge(entry);
      rates.setRate("VES", 44); // el mercado se mueve a mitad de mano
      await wallet.charge({ ...entry, reason: "BET_MULTIPLIER" });

      const amounts = requests.map((r) => (r.body as { amount: number }).amount);
      expect(amounts).toEqual([toCents(1, 40), toCents(1, 40)]);
    });

    it("lo que va por la cola no se cobra por HTTP", async () => {
      await expect(build().charge({ ...entry, reason: "PRIZE" })).rejects.toBeInstanceOf(
        WalletUnavailableError,
      );
      expect(requests).toHaveLength(0);
    });
  });
});
