import type { Application, Request, Response } from "express";

// LOS DOS CHEQUEOS DEL BALANCEADOR, y son DOS porque los contesta gente distinta que hace
// cosas distintas con la respuesta:
//
//   /health  ¿este proceso está roto sin arreglo?   → acción: MATARLO Y REINICIARLO
//   /ready   ¿le mando jugadores nuevos?            → acción: SACARLO DE ROTACIÓN (sigue vivo)
//
// Por eso `/health` NO TOCA NADA. Si fallara porque una base se cayó, le estaría diciendo al
// supervisor "reiniciame" — y reiniciar no arregla la base: lo único que consigue es que todas
// las instancias se reinicien a la vez y se lleven puestas las partidas en curso, que es el
// único daño irreversible que este servidor puede sufrir. Con plata de por medio, una partida
// que muere sin veredicto es un reembolso que nunca se anuncia.
//
// Y acá el argumento es más fuerte que de costumbre porque el dominó SIGUE JUGANDO sin sus
// bases: sin Mongo solo se pierde el historial de soporte, y sin Redis no se pueden abrir salas
// nuevas pero las vivas siguen. Las dos cosas dicen "no me mates, dejame terminar lo que
// tengo", que es la definición exacta de *no listo pero vivo*.
//
// Un motivo más, práctico: un chequeo que consulta una base tarda lo que tarde la base. El que
// existe para detectar el problema no puede quedar arrastrado por el problema.
//
// ESTE ARCHIVO NO CONOCE NINGUNA DEPENDENCIA, igual que el resto de `shared/http`: quién es
// "mongo" y quién es "redis" lo aporta el composition root, que es el único que las conoce.

// LAS DEPENDENCIAS DURAS, POR NOMBRE. El nombre es lo que se devuelve cuando falta, así que la
// clave no es decorativa: es la respuesta.
//
// Un mapa VACÍO es un estado legítimo y no un error — es la instancia sin `MONGO_URI` ni
// `REDIS_URL`, o sea el despliegue por default de este repo — y contesta LISTO. Una dependencia
// que esta instancia eligió no tener no falta.
export type DependencyChecks = Readonly<Record<string, () => Promise<unknown>>>;

// CUÁNTO SE LE DA A CADA DEPENDENCIA PARA CONTESTAR. Corto a propósito: la pregunta es "¿le
// mando jugadores nuevos?", y una base que tarda dos segundos en un ping ya es un no.
const READINESS_TIMEOUT_MS = 2_000;

// EL PLAZO VIVE ACÁ ADENTRO Y NO EN EL LLAMADOR, y es la decisión que hace que este endpoint
// sirva para algo. Una base caída NO FALLA: CUELGA —el driver de Mongo espera treinta segundos
// a que aparezca un servidor—, así que sin plazo `/ready` no contesta nada y el balanceador se
// queda adivinando, que es peor que un 503. Ponerlo del lado del puerto es lo que hace que
// ningún llamador pueda olvidárselo.
//
// Se descarta el resultado del chequeo: lo único que se mide es el VIAJE DE IDA Y VUELTA.
function answersWithin(check: () => Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // `unref()` para que un plazo pendiente no le impida salir al proceso: este servidor se
    // apaga drenando (§`src/main.ts`), y un temporizador de dos segundos colgado de un chequeo
    // que nadie está mirando no puede alargar eso.
    const timer: { unref?: () => void } = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    check()
      .then(
        () => resolve(true),
        () => resolve(false),
      )
      .finally(() => clearTimeout(timer as unknown as Parameters<typeof clearTimeout>[0]));
  });
}

export function registerHealth(
  app: Application,
  checks: DependencyChecks,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): void {
  // VIVO. No consulta nada: que esta línea llegue a ejecutarse ya demuestra que el event loop
  // corre, que es exactamente lo que la pregunta quiere saber.
  app.get("/health", (_request: Request, response: Response) => {
    response.json({ status: "ok", pid: process.pid, uptime: Math.round(process.uptime()) });
  });

  // LISTO. Acá sí se pregunta, porque una instancia que arrancó pero no llega a Redis acepta la
  // conexión y recién falla al crear la sala. Devuelve QUÉ falta y no solo que falta.
  app.get("/ready", async (_request: Request, response: Response) => {
    const entries = Object.entries(checks);
    // A LA VEZ Y NO EN FILA, y el plazo es POR CHEQUEO: en fila, dos dependencias lentas se
    // sumarían y la segunda se reportaría caída por culpa de la primera.
    const answers = await Promise.all(
      entries.map(([name, check]) => answersWithin(check, timeoutMs).then((ok) => ({ name, ok }))),
    );
    const missing = answers.filter((answer) => !answer.ok).map((answer) => answer.name);
    if (missing.length === 0) {
      response.json({ status: "ready" });
      return;
    }
    response.status(503).json({ status: "not-ready", missing });
  });
}
