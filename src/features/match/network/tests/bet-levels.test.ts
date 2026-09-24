import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it, vi } from "vitest";
import type { BetLevel } from "../../core/config";
import { type BetLevelBook, CachedBetLevelBook, NO_BET_LEVELS } from "../bet-levels";
import { HttpBetLevelBook } from "../transports/http-bet-levels";

// DE DÓNDE SALEN LOS NIVELES QUE UNA MESA OFRECE. Dos piezas y dos afirmaciones distintas: el
// adaptador traduce lo que el backend principal devuelve, y la cache decide qué pasa cuando no
// devuelve nada.

const LEVELS: readonly BetLevel[] = [{ level: 2, extra: 1, additionalPoints: 10 }];

describe("el catálogo de niveles, por HTTP", () => {
  const clientOf = (payload: unknown) => {
    const calls: { path: string; headers: Record<string, string> }[] = [];
    const http = {
      get: async (path: string, headers: Record<string, string> = {}) => {
        calls.push({ path, headers });
        return payload;
      },
    };
    return { calls, book: new HttpBetLevelBook(http as never, { value: "la-llave" }) };
  };

  // LA RUTA Y LOS DOS PARÁMETROS SON LOS DE v1, y el `game=domino` no es decorativo: el mismo
  // endpoint le sirve al truco. El `gameModeId` va porque los niveles son POR MESA — el panel
  // puede ofrecer x2 en la barata y x2/x5 en la cara.
  it("pregunta por el modo, con la llave del servidor", async () => {
    const { calls, book } = clientOf({ levels: [] });

    await book.levelsOf("modo con espacios");

    expect(calls[0]?.path).toBe(
      "internal/bet-increase/config?game=domino&gameModeId=modo%20con%20espacios",
    );
    expect(calls[0]?.headers["x-internal-api-key"]).toBe("la-llave");
  });

  it("traduce los niveles que vinieron bien", async () => {
    const { book } = clientOf({ levels: [{ level: 2, extra: 1, additionalPoints: 10 }] });

    expect(await book.levelsOf("m")).toEqual(LEVELS);
  });

  // UNA FILA MAL CARGADA NO DEJA SIN AUMENTAR A LA MESA ENTERA, y es lo que hace v1: se filtra la
  // que no sirve y se conservan las demás.
  it("descarta la fila sin nivel o sin extra, y conserva el resto", async () => {
    const { book } = clientOf({
      levels: [{ level: 2, extra: 1 }, { extra: 5 }, { level: 5 }, { level: "x", extra: 1 }],
    });

    expect(await book.levelsOf("m")).toEqual([{ level: 2, extra: 1, additionalPoints: 0 }]);
  });

  // ⚠ LA ASIMETRÍA ES DE v1 Y NO UN DESCUIDO: `additionalPoints` ausente se completa con cero
  // —«ningún extra sobre el ranking»— y un `extra` ausente NO, porque `extra: 0` sería un nivel
  // que cobra de más y no da un solo punto. Uno es un default, el otro es una fila rota.
  it("completa additionalPoints con cero y NO completa extra", async () => {
    const { book } = clientOf({ levels: [{ level: 3, extra: 2 }, { level: 4 }] });

    expect(await book.levelsOf("m")).toEqual([{ level: 3, extra: 2, additionalPoints: 0 }]);
  });

  it("un cuerpo sin lista no es una mesa con niveles", async () => {
    expect(await clientOf({}).book.levelsOf("m")).toEqual([]);
  });

  // NO ATRAPA NADA, y ése es el punto: el fallo tiene que SALIR para que la cache decida. Si esto
  // devolviera `[]` ante un error, el que pueda tirar el endpoint apagaría la feature sin que
  // nadie lo vea en un log.
  it("deja salir el fallo de red", async () => {
    const book = new HttpBetLevelBook(
      { get: async () => Promise.reject(new Error("502")) } as never,
      { value: "k" },
    );

    await expect(book.levelsOf("m")).rejects.toThrow("502");
  });
});

describe("la cache de niveles", () => {
  const build = (source: BetLevelBook, now = () => 1_000) => {
    const log = new MemoryLogger();
    return { log, book: new CachedBetLevelBook(source, 30_000, now, log) };
  };

  it("no vuelve a preguntar dentro de la ventana", async () => {
    const levelsOf = vi.fn(async () => LEVELS);
    const { book } = build({ levelsOf });

    await book.levelsOf("m");
    await book.levelsOf("m");

    expect(levelsOf).toHaveBeenCalledOnce();
  });

  // ⚠ LA CLAVE ES EL MODO, y con un solo valor cacheado dos modos distintos se pisarían: una mesa
  // cara ofrecería los niveles de una barata, o al revés. Es la única diferencia con
  // `CachedAntifraudFlag`, que cachea un flag global.
  it("cachea POR MODO y no mezcla dos mesas", async () => {
    const porModo: Record<string, readonly BetLevel[]> = {
      cara: [{ level: 5, extra: 5, additionalPoints: 250 }],
      barata: [{ level: 2, extra: 1, additionalPoints: 10 }],
    };
    const { book } = build({ levelsOf: async (id) => porModo[id] ?? [] });

    expect(await book.levelsOf("cara")).toEqual(porModo.cara);
    expect(await book.levelsOf("barata")).toEqual(porModo.barata);
    expect(await book.levelsOf("cara")).toEqual(porModo.cara);
  });

  // VEINTE MESAS DEL MISMO MODO NACIENDO A LA VEZ es exactamente lo que hace un pico de
  // matchmaking. Sin coalescing serían veinte llamadas idénticas en vuelo.
  //
  // LAS DOS SALEN EN EL MISMO TURNO: esperar a que la primera termine deja pasar verde a un libro
  // que solo cachea, que es justo lo que este caso existe para distinguir.
  it("junta las que salen a la vez en una sola llamada", async () => {
    const levelsOf = vi.fn(async () => LEVELS);
    const { book } = build({ levelsOf });

    const [a, b] = await Promise.all([book.levelsOf("m"), book.levelsOf("m")]);

    expect(levelsOf).toHaveBeenCalledOnce();
    expect(a).toEqual(LEVELS);
    expect(b).toEqual(LEVELS);
  });

  // FALLA CERRADO, y acá el criterio se aparta del del antifraude —que falla ENCENDIDO—: el
  // `extra` determina puntos de ranking REALES, y ofrecer un nivel inventado le entrega al
  // jugador un puntaje que nadie configuró.
  it("sin catálogo la mesa no ofrece aumentar, y lo deja escrito", async () => {
    const { book, log } = build({ levelsOf: () => Promise.reject(new Error("502")) });

    expect(await book.levelsOf("m")).toEqual([]);
    expect(log.at_("error")).toHaveLength(1);
  });

  // Y el fallo se cachea como cualquier respuesta: sin eso, un backend caído recibiría una
  // llamada por cada mesa que nace, que es justamente cuando menos puede contestarlas.
  it("no reintenta contra un backend caído en cada mesa", async () => {
    const levelsOf = vi.fn(() => Promise.reject(new Error("502")));
    const { book } = build({ levelsOf });

    await book.levelsOf("m");
    await book.levelsOf("m");

    expect(levelsOf).toHaveBeenCalledOnce();
  });

  it("vuelve a preguntar cuando la ventana venció", async () => {
    const levelsOf = vi.fn(async () => LEVELS);
    let now = 1_000;
    const { book } = build({ levelsOf }, () => now);

    await book.levelsOf("m");
    now += 30_001;
    await book.levelsOf("m");

    expect(levelsOf).toHaveBeenCalledTimes(2);
  });
});

// El reposo del despliegue sin backend: ninguna mesa ofrece aumentar, sin preguntar nada.
describe("el libro de reposo", () => {
  it("no ofrece niveles", async () => {
    expect(await NO_BET_LEVELS.levelsOf("m")).toEqual([]);
  });
});
