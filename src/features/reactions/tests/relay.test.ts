import type { Logger } from "@/logger";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_REACTIONS_CONFIG, type ReactionsConfig } from "../catalog";
import { ReactionLimiter, ReactionRelay, type ReactionSent } from "../relay";
import { REACTION_PACKS, StaticReactionCatalog } from "../static-catalog";

const GESTO = REACTION_PACKS[0]?.items[0] ?? expect.unreachable("el catálogo no puede estar vacío");

function silentLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

// El reloj se mueve a mano: probar una ventana de dos segundos esperando dos segundos no es una
// prueba, es una siesta.
const build = (over: Partial<ReactionsConfig> = {}) => {
  let now = 1_000_000;
  const sent: ReactionSent[] = [];
  const relayed: ReactionSent[] = [];
  const config = { ...DEFAULT_REACTIONS_CONFIG, ...over };
  const log = silentLogger();
  const relay = new ReactionRelay({
    catalog: new StaticReactionCatalog(),
    limiter: new ReactionLimiter(config, () => now),
    publish: (s) => void sent.push(s),
    log,
    onRelayed: (s) => void relayed.push(s),
  });
  return {
    relay,
    sent,
    relayed,
    log,
    passes: (ms: number) => {
      now += ms;
    },
    config,
  };
};

describe("ReactionRelay", () => {
  it("pone el gesto en la mesa, con quién lo mandó y el contenido del catálogo", async () => {
    const { relay, sent } = build();

    await relay.relay("seat-1", GESTO.id);

    expect(sent).toEqual([{ fromPlayerId: "seat-1", reaction: GESTO }]);
  });

  // Acá se cae la diferencia entre esto y un chat: el cliente manda un ID y el contenido lo pone el
  // servidor. Un id que no está en el catálogo no sale a la mesa — si saliera, el contenido lo
  // estaría eligiendo el cliente.
  it("no difunde un gesto que no está en el catálogo, y lo deja en el log de debug", async () => {
    const { relay, sent, log } = build();

    await relay.relay("seat-1", "me-lo-invente");

    expect(sent).toEqual([]);
    expect(log.debug).toHaveBeenCalledWith("gesto descartado: no está en el catálogo", {
      playerId: "seat-1",
      reactionId: "me-lo-invente",
    });
  });

  // Y no revienta: un id viejo es un cliente desactualizado, no un error que deba llegar a nadie.
  it("un id desconocido no lanza", async () => {
    const { relay } = build();

    await expect(relay.relay("seat-1", "me-lo-invente")).resolves.toBeUndefined();
  });
});

describe("ReactionLimiter: la ráfaga y la ventana", () => {
  it("deja la ráfaga completa y corta la siguiente, sólo con un debug", async () => {
    const { relay, sent, config, log } = build();

    for (let i = 0; i < config.perWindow + 2; i++) await relay.relay("seat-1", GESTO.id);

    expect(sent).toHaveLength(config.perWindow);
    expect(log.debug).toHaveBeenCalledWith("gesto descartado: demasiado seguido", {
      playerId: "seat-1",
      reactionId: GESTO.id,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("al pasar la ventana vuelve a dejar", async () => {
    const { relay, sent, passes, config } = build();
    for (let i = 0; i < config.perWindow + 2; i++) await relay.relay("seat-1", GESTO.id);

    passes(config.windowMs + 1);
    await relay.relay("seat-1", GESTO.id);

    expect(sent).toHaveLength(config.perWindow + 1);
  });

  // Por JUGADOR, no por mesa: que uno se pase de rosca no puede dejar mudos a los demás.
  it("el límite es de cada uno", async () => {
    const { relay, sent, config } = build();
    for (let i = 0; i < config.perWindow + 2; i++) await relay.relay("seat-1", GESTO.id);

    await relay.relay("seat-2", GESTO.id);

    expect(sent.at(-1)).toEqual({ fromPlayerId: "seat-2", reaction: GESTO });
  });

  // La ventana DESLIZA: no es un cupo que se reinicia de golpe cada dos segundos —eso dejaría mandar
  // el doble a caballo del corte— sino los últimos `windowMs` mirados desde ahora.
  it("la ventana desliza, no se reinicia por tramos", async () => {
    const { relay, sent, passes } = build({ perWindow: 2, windowMs: 1_000 });

    await relay.relay("seat-1", GESTO.id);
    passes(600);
    await relay.relay("seat-1", GESTO.id);
    passes(600); // el primero ya venció, el segundo no
    await relay.relay("seat-1", GESTO.id);
    await relay.relay("seat-1", GESTO.id); // éste no entra: quedan dos vivos

    expect(sent).toHaveLength(3);
  });

  // Un id inventado también gasta: el límite va ANTES del catálogo, así que mandar basura no es una
  // forma de esquivarlo.
  it("un id desconocido consume del cupo", async () => {
    const { relay, sent, config } = build();
    for (let i = 0; i < config.perWindow; i++) await relay.relay("seat-1", "me-lo-invente");

    await relay.relay("seat-1", GESTO.id);

    expect(sent).toEqual([]);
  });
});

// EL REGISTRO DE USO cuelga de acá: sólo cuenta lo que salió a la mesa.
describe("ReactionRelay: onRelayed", () => {
  it("avisa del gesto que salió, con lo mismo que salió a la mesa", async () => {
    const { relay, sent, relayed } = build();

    await relay.relay("seat-1", GESTO.id);

    expect(relayed).toEqual([{ fromPlayerId: "seat-1", reaction: GESTO }]);
    expect(relayed).toEqual(sent);
  });

  it("no avisa de un gesto que no está en el catálogo ni de uno por encima del límite", async () => {
    const { relay, relayed, config } = build();

    await relay.relay("seat-1", "me-lo-invente");
    for (let i = 0; i < config.perWindow + 2; i++) await relay.relay("seat-2", GESTO.id);

    expect(relayed).toHaveLength(config.perWindow);
    expect(relayed.every(({ fromPlayerId }) => fromPlayerId === "seat-2")).toBe(true);
  });

  it("sin onRelayed el relay difunde igual", async () => {
    const sent: ReactionSent[] = [];
    const relay = new ReactionRelay({
      catalog: new StaticReactionCatalog(),
      limiter: new ReactionLimiter(DEFAULT_REACTIONS_CONFIG),
      publish: (s) => void sent.push(s),
      log: silentLogger(),
    });

    await relay.relay("seat-1", GESTO.id);

    expect(sent).toHaveLength(1);
  });
});
