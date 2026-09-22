import express from "express";
import { describe, expect, it } from "vitest";
import { type DependencyChecks, healthRoutes } from "./health";

// CONTRA UN EXPRESS DE VERDAD Y CON `fetch`, no llamando al handler a mano: lo que este
// archivo tiene que medir es el STATUS que ve el balanceador, y un handler invocado
// directamente no produce ninguno. Es la misma decisión que `http-root-route.e2e.test.ts`.
async function serve(checks: DependencyChecks, timeoutMs?: number) {
  const app = express().use(healthRoutes(checks, timeoutMs));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("el servidor no ató puerto");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    get: (path: string) => fetch(`${base}${path}`),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const arriba = () => Promise.resolve("pong");
const caída = () => Promise.reject(new Error("sin servidor"));
// UNA BASE CAÍDA NO FALLA: CUELGA. El driver de Mongo espera treinta segundos a que aparezca
// un servidor, así que esta promesa —que nunca se resuelve— es el caso REAL y no uno inventado.
const colgada = () => new Promise<never>(() => {});

describe("los dos chequeos del balanceador", () => {
  // LA DIFERENCIA ENTRE LOS DOS ES TODO LO QUE HAY QUE CUIDAR. Si VIVO también mirara las
  // bases, una caída de Mongo le diría al supervisor "reiniciame" — y reiniciar no arregla una
  // base: lo único que consigue es que todas las instancias se reinicien a la vez y se lleven
  // puestas las partidas en curso, que es el único daño irreversible que este servidor puede
  // sufrir. Y el dominó SIGUE JUGANDO sin sus bases: sin Mongo solo se pierde el historial, sin
  // Redis no se abren salas nuevas pero las vivas siguen.
  it("VIVO contesta 200 aunque TODAS las dependencias estén caídas", async () => {
    const server = await serve({ mongo: caída, redis: caída });

    const response = await server.get("/health");

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ok");
    await server.close();
  });

  it("LISTO, en cambio, dice que no — y dice CUÁL falta", async () => {
    const server = await serve({ mongo: caída, redis: arriba });

    const response = await server.get("/ready");

    // Un 503 sin motivo obliga a entrar al servidor a averiguarlo, que es justo lo que este
    // endpoint existe para evitar.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready", missing: ["mongo"] });
    await server.close();
  });

  // RABBIT ENTRA AL MAPA COMO TERCERA DEPENDENCIA DURA, y su chequeo es `ping()`: abre el canal
  // SIN publicar, porque una sonda que publicara mandaría un evento de catálogo a los consumidores
  // en cada latido del balanceador.
  //
  // ⚠ SE MIDE CON `colgada` Y NO CON `caída`, y ésa es la parte que importa: `amqplib` con
  // `recovery: true` usa `maxRetries: Infinity`, así que contra un broker apagado el connect NO
  // rechaza — se queda esperando (§`src/shared/amqp.ts`). Lo único que convierte eso en un 503 es
  // el plazo POR CHEQUEO de este archivo. Un test con una promesa rechazada daría verde aunque el
  // plazo no existiera, y el síntoma en producción sería un `/ready` que no contesta NADA: el
  // balanceador sacaría la instancia por timeout suyo, sin decir qué falta.
  it("LISTO nombra a rabbit cuando el broker cuelga en vez de rechazar", async () => {
    const server = await serve({ mongo: arriba, redis: arriba, rabbit: colgada }, 30);

    const response = await server.get("/ready");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready", missing: ["rabbit"] });
    await server.close();
  });

  // Y VIVO SIGUE EN 200 CON EL BROKER COLGADO, por lo mismo que con Mongo: el dominó sigue jugando
  // sin publicar. Los eventos quedan en el outbox durable y salen cuando el broker vuelve; reiniciar
  // la instancia no arreglaría el broker y sí se llevaría puestas las partidas en curso.
  it("VIVO contesta 200 con el broker colgado", async () => {
    const server = await serve({ mongo: arriba, redis: arriba, rabbit: colgada }, 30);

    expect((await server.get("/health")).status).toBe(200);
    await server.close();
  });

  it("con todo arriba los dos contestan que sí", async () => {
    const server = await serve({ mongo: arriba, redis: arriba });

    expect((await server.get("/health")).status).toBe(200);
    expect((await server.get("/ready")).status).toBe(200);
    await server.close();
  });

  // EL PLAZO POR CHEQUEO es lo que hace que esto sirva para algo. Sin él, una base que cuelga
  // deja a `/ready` mudo —ni 200 ni 503— y el balanceador adivinando; con él, el silencio se
  // convierte en una respuesta con nombre.
  it("una dependencia que CUELGA se reporta como faltante, no deja al endpoint mudo", async () => {
    const server = await serve({ mongo: colgada, redis: arriba }, 30);

    const response = await server.get("/ready");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready", missing: ["mongo"] });
    await server.close();
  });

  // EL PLAZO ES POR CHEQUEO Y NO PARA EL CONJUNTO, y por eso los chequeos corren a la vez: con
  // un plazo global, dos dependencias lentas se sumarían y la segunda se reportaría caída por
  // culpa de la primera.
  it("dos que cuelgan se reportan las dos, y en un solo plazo", async () => {
    const server = await serve({ mongo: colgada, redis: colgada }, 30);

    const empezó = Date.now();
    const response = await server.get("/ready");

    expect(await response.json()).toEqual({ status: "not-ready", missing: ["mongo", "redis"] });
    expect(Date.now() - empezó).toBeLessThan(500);
    await server.close();
  });

  // UNA DEPENDENCIA QUE ESTA INSTANCIA ELIGIÓ NO TENER NO FALTA. Sin `MONGO_URI` el historial es
  // el de memoria y sin `REDIS_URL` este proceso es un clúster de uno: las dos son decisiones,
  // no fallas, y un `/ready` que las contara como faltantes sacaría de rotación para siempre a
  // la instancia única — que es el despliegue por default de este repo.
  it("sin dependencias duras contesta LISTO", async () => {
    const server = await serve({});

    expect((await server.get("/ready")).status).toBe(200);
    await server.close();
  });
});
