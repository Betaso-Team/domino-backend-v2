import { randomUUID } from "node:crypto";
import type { Logger } from "@/logger";
import type { OutboxStore } from "@/shared/outbox";
import type { CatalogEvent, CatalogEvents, CatalogTopic } from "../core/catalog-events";

// LOS ANUNCIOS DEL CATÁLOGO AL OUTBOX DURABLE (`catalog_event_outbox`), que su propio despachador
// publica en `betaso_games`: otro outbox que el de los resultados, así que un anuncio que no sale
// nunca frena un resultado de partida. La clave de cada entrada es nueva (`<uuid>:<topic>`) y es el
// `messageId`: quien consume deduplica por ella.
//
// NUNCA HACE FALLAR LA MUTACIÓN: el modo ya se escribió; si encolar falla, se pierde el aviso y queda
// en el log.
export class OutboxCatalogEvents implements CatalogEvents {
  constructor(
    private readonly outbox: OutboxStore<CatalogTopic, CatalogEvent["payload"]>,
    private readonly wake: () => void,
    private readonly log: Logger,
  ) {}

  async announce(event: CatalogEvent): Promise<void> {
    try {
      await this.outbox.enqueue(`${randomUUID()}:${event.topic}`, event.topic, event.payload);
      this.wake();
    } catch (error) {
      this.log.error("no se pudo encolar el anuncio del catálogo", {
        err: error,
        topic: event.topic,
      });
    }
  }
}
