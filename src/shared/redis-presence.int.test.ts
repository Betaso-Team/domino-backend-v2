import { REDIS_INT_URL } from "@/tests/int-services";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DominoRedisPresence } from "./redis-presence";

// EL COMPARE-AND-DELETE CONTRA UN REDIS DE VERDAD. La carrera que cierra: el registro suelta a un
// jugador de la mesa vieja (borra `player_match:<id>` si todavía apunta a ella) mientras la mesa nueva
// escribe la misma clave. Con `get` + `del` separados, el `del` podía llevarse la clave nueva.
let redis: DominoRedisPresence;
// OTRA CONEXIÓN, como otro proceso: con una sola, los dos comandos salen en fila y no hay carrera.
let other: DominoRedisPresence;

describe.skipIf(!REDIS_INT_URL)("DominoRedisPresence contra Redis", () => {
  beforeAll(() => {
    redis = new DominoRedisPresence(REDIS_INT_URL as string);
    other = new DominoRedisPresence(REDIS_INT_URL as string);
  });

  afterAll(() => {
    redis.shutdown();
    other.shutdown();
  });

  it("borra sólo si la clave tiene ese valor", async () => {
    await redis.set("cad:k", "room-a");
    expect(await redis.delIfEquals("cad:k", "room-b")).toBe(false);
    expect(await redis.get("cad:k")).toBe("room-a");
    expect(await redis.delIfEquals("cad:k", "room-a")).toBe(true);
    expect(await redis.get("cad:k")).toBeNull();
    expect(await redis.delIfEquals("cad:k", "room-a")).toBe(false);
  });

  it("en carrera con la escritura de la mesa nueva, la clave nueva sobrevive siempre", async () => {
    for (let i = 0; i < 200; i += 1) {
      const key = `cad:race:${i}`;
      await redis.setex(key, "room-old", 30);
      await Promise.all([redis.delIfEquals(key, "room-old"), other.setex(key, "room-new", 30)]);
      expect(await redis.get(key)).toBe("room-new");
    }
  });
});
