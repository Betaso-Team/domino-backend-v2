import { describe, expect, it } from "vitest";
import type { MuteChangeRecord, ReactionUsageRecord, ReactionUsageStore } from "../../usage";

// EL REGISTRO DE USO, escrito una vez y corrido contra los dos adaptadores (el criterio de
// `features/match/network/transports/tests/history-contract.ts`): el de memoria no es un doble, y dos
// copias del contrato derivan. Cada adaptador devuelve lo guardado en el vocabulario del código; la
// forma en la base (los campos de v1) la fija aparte el test de Mongo.

export interface ReactionUsageUnderTest {
  readonly store: ReactionUsageStore;
  reactions(): Promise<readonly ReactionUsageRecord[]>;
  muteChanges(): Promise<readonly MuteChangeRecord[]>;
}

const AT = new Date("2026-11-12T12:00:00.000Z");

export const reaction = (overrides: Partial<ReactionUsageRecord> = {}): ReactionUsageRecord => ({
  eventId: "7c0d8a52-3f43-4a54-9d7a-0d4f3c0f6a01",
  userId: "u-ana",
  providerId: "betaso",
  matchId: "orq-1",
  gameKind: "paga",
  reactionId: "fire",
  emoji: "🔥",
  at: AT,
  ...overrides,
});

export const muteChange = (overrides: Partial<MuteChangeRecord> = {}): MuteChangeRecord => ({
  eventId: "2b3c9a8e-6e8a-4a3f-8c51-5a4f1d2e7b02",
  userId: "u-ana",
  providerId: "betaso",
  muted: true,
  origin: "partida",
  matchId: "orq-1",
  at: AT,
  ...overrides,
});

export function reactionUsageContract(
  make: () => Promise<ReactionUsageUnderTest> | ReactionUsageUnderTest,
): void {
  describe("ReactionUsageStore (contrato)", () => {
    it("guarda cada gesto, también el mismo emoji dos veces", async () => {
      const usage = await make();
      const first = reaction();
      const second = reaction({ eventId: "9e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a04" });

      await usage.store.recordReaction(first);
      await usage.store.recordReaction(second);

      expect(await usage.reactions()).toEqual([first, second]);
    });

    it("guarda cada cambio de silencio, en los dos sentidos", async () => {
      const usage = await make();
      const mute = muteChange();
      const unmute = muteChange({
        eventId: "5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d05",
        muted: false,
      });

      await usage.store.recordMuteChange(mute);
      await usage.store.recordMuteChange(unmute);

      expect(await usage.muteChanges()).toEqual([mute, unmute]);
    });

    // EL `eventId` LO GENERA EL CLIENTE, y un reenvío (una reconexión que repite el mensaje) es el
    // mismo cambio. Se queda el primero y el segundo no rechaza.
    it("un cambio de silencio repetido con el mismo eventId queda una sola vez, sin error", async () => {
      const usage = await make();
      const mute = muteChange();

      await usage.store.recordMuteChange(mute);
      await expect(
        usage.store.recordMuteChange({ ...mute, at: new Date(AT.getTime() + 1_000) }),
      ).resolves.toBeUndefined();

      expect(await usage.muteChanges()).toEqual([mute]);
    });
  });
}
