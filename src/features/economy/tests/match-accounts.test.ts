import { FakeAccountDirectory } from "@/features/economy/tests/fake-accounts";
import { describe, expect, it } from "vitest";
import { MatchAccounts } from "../match-accounts";

// The rule this file guards is about BUSINESS and not performance: a player enters with one currency
// and is paid in that one, even if they switch currency in the app mid-match. Without it, the charge
// and the prize of one match can come out in different currencies.
describe("MatchAccounts", () => {
  it("congela: lo que se cobró y lo que se paga miran la misma cuenta", async () => {
    const directory = new FakeAccountDirectory();
    directory.setAccount("u1", { currency: "VES", username: "gabriel" });
    const accounts = new MatchAccounts(directory);

    // Admission, with the player's token.
    const alEntrar = await accounts.accountOf("room-1", "u1", "token-de-u1");
    // They switch currency mid-match.
    directory.setAccount("u1", { currency: "USD", username: "gabriel" });
    // The prize, minutes later and with no credential.
    const alPagar = await accounts.accountOf("room-1", "u1");

    expect(alEntrar.currency).toBe("VES");
    expect(alPagar.currency).toBe("VES");
  });

  it("es por PARTIDA: la siguiente vuelve a preguntar", async () => {
    const directory = new FakeAccountDirectory();
    directory.setAccount("u1", { currency: "VES" });
    const accounts = new MatchAccounts(directory);

    await accounts.accountOf("room-1", "u1", "t");
    directory.setAccount("u1", { currency: "USD" });

    expect((await accounts.accountOf("room-2", "u1", "t")).currency).toBe("USD");
  });

  it("y por JUGADOR: en una mesa cada uno puede estar en la suya", async () => {
    const directory = new FakeAccountDirectory();
    directory.setAccount("u1", { currency: "VES" });
    directory.setAccount("u2", { currency: "USD" });
    const accounts = new MatchAccounts(directory);

    expect((await accounts.accountOf("room-1", "u1", "t")).currency).toBe("VES");
    expect((await accounts.accountOf("room-1", "u2", "t")).currency).toBe("USD");
  });

  it("dos preguntas simultáneas de la misma partida ven lo mismo", async () => {
    const directory = new FakeAccountDirectory();
    directory.setAccount("u1", { currency: "VES" });
    const accounts = new MatchAccounts(directory);

    const [a, b] = await Promise.all([
      accounts.accountOf("room-1", "u1", "t"),
      accounts.accountOf("room-1", "u1", "t"),
    ]);

    expect(a).toBe(b);
  });
});
