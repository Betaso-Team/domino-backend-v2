import { withRetries } from "@/shared/retry";
import { describe, expect, it, vi } from "vitest";

// EL BUCLE DE REINTENTOS, que es lo que sostiene toda entrega saliente del repo. Lo que se mide
// son las cuatro formas de SALIR, porque cada una tapa algo distinto y equivocarse en cualquiera
// deja un efecto perdido o un proceso que no termina de apagarse.

// Plazos en cero: lo que se mide es el bucle y no cuánto duerme. Con los reales, este archivo
// tardaría minutos en decir lo mismo.
const NOW = { maxAttempts: 3, baseDelayMs: 0 };

describe("withRetries", () => {
  it("con un intento que sale, no reintenta", async () => {
    const attempt = vi.fn(async () => undefined);

    expect(await withRetries(attempt, NOW)).toBe(true);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("reintenta hasta que sale", async () => {
    let fallos = 2;
    const attempt = vi.fn(async () => {
      if (fallos-- > 0) throw new Error("todavía no");
    });

    expect(await withRetries(attempt, NOW)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  // SE RINDE Y LO DICE. El `false` es lo que el llamador convierte en «esto quedó pendiente»: un
  // bucle que lanzara obligaría a cada entrega a envolverlo en un try, y el que se olvide pierde
  // el efecto sin enterarse.
  it("agotados los intentos devuelve false en vez de lanzar", async () => {
    const attempt = vi.fn(async () => Promise.reject(new Error("caído")));

    expect(await withRetries(attempt, NOW)).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  // ⚠ UN RECHAZO NO ES UNA CAÍDA. Reintentar un «no» de la otra punta gasta los tres intentos
  // para recibir el mismo «no» tres veces, y encima retrasa lo que venga detrás.
  it("un error final corta sin gastar los intentos que quedan", async () => {
    const attempt = vi.fn(async () => Promise.reject(new Error("rechazado")));

    const landed = await withRetries(attempt, NOW, { isFinal: () => true });

    expect(landed).toBe(false);
    expect(attempt).toHaveBeenCalledOnce();
  });

  // EL APAGADO ORDENADO NO ESPERA A LOS REINTENTOS. Sin esto, una señal con entregas en vuelo
  // tendría que aguantar el backoff completo de cada una antes de que el proceso salga.
  it("una señal abortada corta antes de intentar", async () => {
    const attempt = vi.fn(async () => undefined);
    const signal = AbortSignal.abort();

    expect(await withRetries(attempt, NOW, { signal })).toBe(false);
    expect(attempt).not.toHaveBeenCalled();
  });

  // EL ERROR INTERMEDIO NO SE PIERDE, y sin este aviso una entrega que salió al tercer intento se
  // ve igual que una que salió al primero: los dos fallos —la señal de que la otra punta está en
  // problemas— no existirían en ningún lado.
  it("avisa de cada intento fallido, y dice si va a haber otro", async () => {
    let fallos = 2;
    const visto: { attempt: number; willRetry: boolean }[] = [];
    const attempt = async () => {
      if (fallos-- > 0) throw new Error("todavía no");
    };

    await withRetries(attempt, NOW, {
      onAttemptFailed: (_e, attemptNumber, willRetry) =>
        visto.push({ attempt: attemptNumber, willRetry }),
    });

    expect(visto).toEqual([
      { attempt: 1, willRetry: true },
      { attempt: 2, willRetry: true },
    ]);
  });

  // EL ÚLTIMO FALLO DICE QUE NO VIENE OTRO, y es lo que distingue «se está reintentando» de «se
  // perdió»: quien registra esto es quien tiene que levantar la mano.
  it("el último intento avisa que ya no hay reintento", async () => {
    const visto: boolean[] = [];

    await withRetries(async () => Promise.reject(new Error("caído")), NOW, {
      onAttemptFailed: (_e, _n, willRetry) => visto.push(willRetry),
    });

    expect(visto).toEqual([true, true, false]);
  });

  // Y un error FINAL tampoco promete un reintento que no va a pasar.
  it("un error final avisa que no viene otro", async () => {
    const visto: boolean[] = [];

    await withRetries(async () => Promise.reject(new Error("rechazado")), NOW, {
      isFinal: () => true,
      onAttemptFailed: (_e, _n, willRetry) => visto.push(willRetry),
    });

    expect(visto).toEqual([false]);
  });

  // EL BACKOFF DUPLICA, y va ANTES de cada intento incluido el primero. Que el primero también
  // espere es deliberado: quien llama acá ya sabe que la otra punta puede estar en problemas.
  it("espera el doble en cada vuelta", async () => {
    const dormido: number[] = [];
    const real = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      dormido.push(ms ?? 0);
      return real(fn, 0);
    }) as typeof setTimeout);

    await withRetries(async () => Promise.reject(new Error("caído")), {
      maxAttempts: 3,
      baseDelayMs: 500,
    });

    vi.unstubAllGlobals();
    expect(dormido).toEqual([500, 1_000, 2_000]);
  });
});
