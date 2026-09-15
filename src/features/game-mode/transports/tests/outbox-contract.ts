import { describe, expect, it } from "vitest";
import type { GameMode } from "../../core/game-mode.js";
import type { GameModeOutbox } from "../../outbox.js";
import { BASE_INSTANT, type MutableClock } from "./repository-contract.js";

// EL CONTRATO DEL OUTBOX, ESCRITO UNA SOLA VEZ Y CORRIDO CONTRA LOS DOS ADAPTADORES, por el mismo
// argumento que `repository-contract.ts`: `MemoryGameModeOutbox` no es un doble de test, es el outbox
// de la instancia que corre sin Mongo. Dos suites paralelas describiendo "lo mismo" derivan en cuanto
// una tarea toque la clave de deduplicación o el orden de entrega, y entonces el despliegue sin
// `MONGO_URI` publica el catálogo de otra forma — o lo publica dos veces.
//
// Lo que NO vive acá es lo que sólo uno de los dos puede tener: el nombre de la colección, los dos
// índices, la forma del documento y el hex del `ObjectId` son del adaptador Mongo y se miden en su
// propio archivo. El contrato mide el PUERTO, y lo mide SÓLO por el puerto: no hay inspector de
// "todas las entradas" porque la única ventana que la producción usa es `next()`, y una aserción
// contra una ventana que nadie usa mide un método de test.

// El modo de referencia es el de `events.test.ts`: `id` y `uuid` DISTINTOS —son los dos candidatos a
// `payload.id` y con el mismo valor ninguna aserción distingue cuál se mapeó— y un `uuid` corto para
// que las claves de deduplicación se puedan escribir como literal.
export function clasica(over: Partial<GameMode> = {}): GameMode {
  return {
    id: "507f1f77bcf86cd799439011",
    uuid: "mode-1",
    name: "Clásica",
    multiplier: 2,
    prize: 18,
    entryFee: 10,
    playersQuantity: 2,
    pointsToWin: 25,
    isActive: true,
    isFreeRoom: true,
    enableBots: true,
    createdAt: new Date(BASE_INSTANT),
    updatedAt: new Date(BASE_INSTANT),
    version: 0,
    ...over,
  };
}

// EL CUERPO QUE VIAJA, escrito entero y una vez. Es el de `events.ts` —sin `isFreeRoom` ni
// `enableBots`— y se repite como literal a propósito: reconstruirlo con `updatedEventOf` mediría que
// dos llamadas a la misma función dan lo mismo.
const CLASICA_PAYLOAD = {
  id: "mode-1",
  game: "domino",
  name: "Clásica",
  isActive: true,
  prize: 18,
  entryFee: 10,
  multiplier: 2,
  pointsToWin: 25,
  playerCount: 2,
};

export interface OutboxHarness {
  readonly outbox: GameModeOutbox;
  readonly clock: MutableClock;
}

export function describeGameModeOutboxContract(
  label: string,
  harnessOf: () => OutboxHarness,
): void {
  describe(`${label}: encolado e idempotencia`, () => {
    // UNA VEZ Y NO DOS. El servicio puede reintentar la escritura del outbox después de un fallo
    // parcial, y el reconciliador mira el mismo modo en cada tick: sin la clave, cada mirada sería
    // un evento más para el consumidor.
    it("enqueueCreated escribe el evento de creación una sola vez", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());

      await outbox.enqueueCreated(clasica());
      await outbox.enqueueCreated(clasica());

      const entry = await outbox.next(now);
      expect(entry).toEqual({
        id: expect.any(String),
        // La clave se asserta como LITERAL y no recalculada con el mismo `JSON.stringify` del
        // código: recalcularla mide que dos expresiones idénticas dan lo mismo, y acompañaría
        // cualquier cambio de formato sin ponerse roja. Es la misma decisión que las claves de
        // idempotencia de `settlementOf`.
        dedupeKey: '["game_mode.created","mode-1"]',
        routingKey: "game_mode.created",
        payload: CLASICA_PAYLOAD,
        status: "PENDING",
        attempts: 0,
        createdAt: now,
        // NACE VENCIDA: el primer intento es AHORA. Una entrada que naciera con el plazo del
        // primer backoff le agregaría un segundo de latencia a cada cambio del panel.
        nextAttemptAt: now,
      });

      await outbox.sent(entry?.id ?? "", now);

      expect(await outbox.next(now)).toBeUndefined();
    });

    // LA CLAVE ES `uuid + version`, y la revisión es el `__v` que la base incrementa. Dos cambios
    // reales que compartieran revisión serían un evento publicado y otro DESCARTADO EN SILENCIO
    // —el consumidor se queda con el catálogo viejo y nadie ve un error—; por eso el repositorio
    // usa `$inc` y no el reloj.
    it("ensureUpdated deduplica por uuid y revisión con una clave determinista", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());

      await outbox.ensureUpdated(clasica({ version: 3 }));
      await outbox.ensureUpdated(clasica({ version: 3 }));

      const entry = await outbox.next(now);
      expect(entry).toMatchObject({
        dedupeKey: '["game_mode.updated","mode-1",3]',
        routingKey: "game_mode.updated",
        payload: CLASICA_PAYLOAD,
      });

      await outbox.sent(entry?.id ?? "", now);
      expect(await outbox.next(now)).toBeUndefined();

      // La revisión siguiente es un evento nuevo: la clave deduplica la REPETICIÓN, no el cambio.
      await outbox.ensureUpdated(clasica({ version: 4 }));

      expect(await outbox.next(now)).toMatchObject({
        dedupeKey: '["game_mode.updated","mode-1",4]',
      });
    });

    // `POST /sync` ES EL BOTÓN DE "REPUBLICAR TODO" DEL OPERADOR (el `/sync` de v1), así que tiene
    // que forzar un evento AUNQUE esa revisión ya se haya publicado: su clave es `batchId + uuid` y
    // no `uuid + version`. Con la clave de revisión, el operador apretaría el botón y no pasaría
    // nada — que es justo el caso en que lo aprieta, porque el consumidor se quedó sin el evento.
    it("sync fuerza un evento por modo aunque la revisión ya esté publicada", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());
      const uno = clasica({ version: 3 });
      const otro = clasica({ uuid: "mode-2", name: "Rápida", version: 5 });
      await outbox.ensureUpdated(uno);
      await outbox.ensureUpdated(otro);
      await drain(outbox, now);

      expect(await outbox.sync([uno, otro], "batch-1")).toBe(2);

      const primero = await outbox.next(now);
      expect(primero).toMatchObject({
        dedupeKey: '["game_mode.sync","batch-1","mode-1"]',
        routingKey: "game_mode.updated",
        payload: CLASICA_PAYLOAD,
      });
      await outbox.sent(primero?.id ?? "", now);

      const segundo = await outbox.next(now);
      expect(segundo).toMatchObject({
        dedupeKey: '["game_mode.sync","batch-1","mode-2"]',
        routingKey: "game_mode.updated",
      });
      await outbox.sent(segundo?.id ?? "", now);

      expect(await outbox.next(now)).toBeUndefined();
    });

    // EL `batchId` ES LO QUE DISTINGUE DOS APRETADAS DEL BOTÓN. Repetir el mismo lote no duplica
    // —un reintento del mismo request no tiene por qué publicar dos veces— y un lote nuevo sí
    // vuelve a encolar.
    it("repetir el lote no duplica y un lote nuevo vuelve a encolar", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());
      const modo = clasica();

      expect(await outbox.sync([modo], "batch-1")).toBe(1);
      expect(await outbox.sync([modo], "batch-1")).toBe(1);
      await drain(outbox, now);
      expect(await outbox.next(now)).toBeUndefined();

      await outbox.sync([modo], "batch-2");

      expect(await outbox.next(now)).toMatchObject({
        dedupeKey: '["game_mode.sync","batch-2","mode-1"]',
      });
    });

    it("sin entradas, next() no entrega nada", async () => {
      const { outbox, clock } = harnessOf();

      expect(await outbox.next(new Date(clock.now()))).toBeUndefined();
    });
  });

  describe(`${label}: orden de entrega y reintento`, () => {
    // NO SE ADELANTA EL SIGUIENTE, y es la regla que justifica que el outbox exista. La entrega es
    // al menos una vez por diseño —un duplicado lo deduplica el consumidor—, pero un `updated`
    // aplicado ANTES que el `updated` anterior deja al consumidor con el modo viejo y sin error de
    // nadie. Por eso `next()` mira el más viejo y devuelve VACÍO si todavía no le toca, en vez de
    // ofrecer el que sí está vencido.
    it("entrega el más viejo y no adelanta el siguiente mientras el primero espera", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());
      const luego = new Date(BASE_INSTANT + 1_000);
      await outbox.enqueueCreated(clasica());
      await outbox.ensureUpdated(clasica({ uuid: "mode-2", name: "Rápida", version: 1 }));

      const primero = await outbox.next(now);
      expect(primero).toMatchObject({ dedupeKey: '["game_mode.created","mode-1"]' });

      await outbox.retry(primero?.id ?? "", "el broker no confirmó", luego);

      // Ni el primero —todavía no le toca— ni el segundo —que no puede adelantarse—.
      expect(await outbox.next(now)).toBeUndefined();

      const reintento = await outbox.next(luego);
      expect(reintento).toMatchObject({
        id: primero?.id,
        attempts: 1,
        lastError: "el broker no confirmó",
        nextAttemptAt: luego,
        status: "PENDING",
      });

      await outbox.sent(reintento?.id ?? "", luego);

      expect(await outbox.next(luego)).toMatchObject({
        dedupeKey: '["game_mode.updated","mode-2",1]',
      });
    });

    // `nextAttemptAt` ES EL INSTANTE EN QUE VUELVE A TOCAR, no el último en que espera: con `<`
    // en vez de `<=` una entrada agendada para exactamente ahora se saltea el tick, y con un
    // dispatcher que lee el reloj una sola vez por tick eso es un segundo perdido por reintento.
    it("una entrada agendada para justo ahora ya es entregable", async () => {
      const { outbox, clock } = harnessOf();
      const luego = new Date(BASE_INSTANT + 1_000);
      await outbox.enqueueCreated(clasica());
      const entry = await outbox.next(new Date(clock.now()));
      await outbox.retry(entry?.id ?? "", "sin confirmar", luego);

      expect(await outbox.next(luego)).toMatchObject({ id: entry?.id });
    });

    // Los intentos se ACUMULAN, no se reescriben: el backoff del dispatcher se calcula con ese
    // número, así que un `attempts` que volviera a 1 dejaría el reintento clavado en un segundo
    // para siempre y el broker caído recibiría un intento por segundo hasta que vuelva.
    it("cada fallo acumula un intento", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());
      await outbox.enqueueCreated(clasica());
      const entry = await outbox.next(now);

      await outbox.retry(entry?.id ?? "", "primero", now);
      await outbox.retry(entry?.id ?? "", "segundo", now);

      expect(await outbox.next(now)).toMatchObject({ attempts: 2, lastError: "segundo" });
    });
  });

  describe(`${label}: reconciliación`, () => {
    // LA VENTANA QUE NO HAY TRANSACCIÓN QUE CIERRE. No se exige replica set, así que escribir el
    // modo y escribir el outbox son dos operaciones: un proceso que muere entre las dos deja un
    // modo con revisión y sin evento. El reconciliador lo compara y emite el que falta.
    it("un modo sin evento recibe un updated", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());

      await outbox.reconcile([clasica({ version: 2 })]);

      expect(await outbox.next(now)).toMatchObject({
        dedupeKey: '["game_mode.updated","mode-1",2]',
        routingKey: "game_mode.updated",
        payload: CLASICA_PAYLOAD,
      });
    });

    // UN `created` PERDIDO VUELVE COMO `updated`, exactamente la estrategia de recuperación del
    // `/sync` de v1: el cuerpo es el mismo y el consumidor upsertea por `id`, así que la clave de
    // ruteo es lo único que cambia — y no hay forma de saber, mirando el modo, si su evento
    // perdido era el de creación.
    it("un modo en revisión cero sin evento también vuelve como updated", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());

      await outbox.reconcile([clasica()]);

      expect(await outbox.next(now)).toMatchObject({
        dedupeKey: '["game_mode.updated","mode-1",0]',
        routingKey: "game_mode.updated",
      });
    });

    // EL `created` CUENTA COMO EVENTO DE LA REVISIÓN CERO, y es la mitad de la reconciliación que
    // no se ve: sin mirarlo, todo modo recién creado recibiría además un `updated` en el primer
    // tick posterior —un evento de más por cada alta del panel, para siempre—.
    it("un modo con su created encolado no recibe nada", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());
      await outbox.enqueueCreated(clasica());

      await outbox.reconcile([clasica()]);

      const entry = await outbox.next(now);
      expect(entry).toMatchObject({ dedupeKey: '["game_mode.created","mode-1"]' });
      await outbox.sent(entry?.id ?? "", now);
      expect(await outbox.next(now)).toBeUndefined();
    });

    // EL EVENTO YA ENTREGADO SIGUE CONTANDO. Los registros `SENT` se conservan —no hay TTL ni
    // borrado— justamente para esto: si la reconciliación sólo mirara lo pendiente, cada tick
    // volvería a emitir el evento de toda revisión ya publicada y el outbox no dejaría de crecer.
    it("un modo cuyo evento ya se entregó no recibe nada", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());
      const modo = clasica({ version: 2 });
      await outbox.ensureUpdated(modo);
      await drain(outbox, now);

      await outbox.reconcile([modo]);

      expect(await outbox.next(now)).toBeUndefined();
    });

    // La revisión SIGUIENTE sí falta: reconciliar no es "este modo ya publicó alguna vez", es
    // "este modo publicó ESTA revisión".
    it("una revisión nueva sin evento se emite aunque la anterior esté entregada", async () => {
      const { outbox, clock } = harnessOf();
      const now = new Date(clock.now());
      await outbox.ensureUpdated(clasica({ version: 2 }));
      await drain(outbox, now);

      await outbox.reconcile([clasica({ version: 3 })]);

      expect(await outbox.next(now)).toMatchObject({
        dedupeKey: '["game_mode.updated","mode-1",3]',
      });
    });

    it("un catálogo vacío no encola nada", async () => {
      const { outbox, clock } = harnessOf();

      await outbox.reconcile([]);

      expect(await outbox.next(new Date(clock.now()))).toBeUndefined();
    });
  });
}

// Marca todo lo pendiente como entregado, que es lo que haría el dispatcher con el broker sano.
// Vive acá y no en cada test porque la mitad de la reconciliación se mide DESPUÉS de entregar.
async function drain(outbox: GameModeOutbox, now: Date): Promise<void> {
  for (let entry = await outbox.next(now); entry; entry = await outbox.next(now)) {
    await outbox.sent(entry.id, now);
  }
}
