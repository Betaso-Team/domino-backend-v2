import type { Logger } from "@/logger";
import type { Reaction, ReactionCatalog, ReactionsConfig } from "./catalog";

// A QUIÉN LE TOCA ESPERAR. Ventana deslizante por jugador: `perWindow` gestos cada `windowMs`.
//
// **Consume el permiso en vez de preguntar por él**, y la diferencia importa: preguntar y después
// mandar son dos pasos, y entre los dos entra el mensaje siguiente. Con una sola operación no hay
// hueco.
//
// Vive por MESA —la instancia la arma el cableado de la sala— así que el mapa muere con la mesa y
// nunca tiene más de cuatro entradas. No hace falta Redis: limitar el spam en una mesa es una
// pregunta de esa mesa, no del clúster.
export class ReactionLimiter {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly config: ReactionsConfig,
    private readonly now: () => number = Date.now,
  ) {}

  take(playerId: string): boolean {
    const since = this.now() - this.config.windowMs;
    // Se descartan los vencidos al mirar, que es el único momento en que pasa algo acá: sin esto el
    // arreglo crecería toda la partida.
    const times = (this.recent.get(playerId) ?? []).filter((at) => at > since);
    this.recent.set(playerId, times);
    if (times.length >= this.config.perWindow) return false;
    times.push(this.now());
    return true;
  }
}

// LO QUE SALE A LA MESA. No lleva destinatario: un gesto es para todos (el `targetPlayerId` de v1
// de truco viajaba de vuelta sin que el servidor hiciera nada con él). Ni precio: lo que cuesta un
// gesto no es asunto de la mesa.
export interface ReactionSent {
  readonly fromPlayerId: string;
  readonly reaction: Reaction;
}

export interface ReactionRelayDeps {
  readonly catalog: ReactionCatalog;
  readonly limiter: ReactionLimiter;
  // Cómo llega el gesto a la mesa. Llega como función porque difundir es de TRANSPORTE: esta feature
  // no sabe que existe un socket, igual que no sabe que existe el dominó.
  readonly publish: (sent: ReactionSent) => void;
  readonly log: Logger;
  // LO QUE PASA DESPUÉS DE QUE EL GESTO SALIÓ: el registro de uso para BI (`usage.ts`). Sólo lo ve un
  // gesto que llegó a la mesa: uno descartado por el límite o por el catálogo no es un uso.
  readonly onRelayed?: (sent: ReactionSent) => void;
}

// EL RELAY: recibe "fulano quiere mandar este gesto" y lo pone en la mesa, o no. No puntúa, no cobra y
// nada de esto entra en el historial; lo único que se guarda es el uso, por `onRelayed`.
//
// **Los dos rechazos son silenciosos**: al que le llega el gesto no le pasa nada, y al que lo mandó
// tampoco. Un gesto que no sale no es un error que la pantalla tenga que dibujar, y el cliente ya
// sabe su propio ritmo. Quedan en el log de debug, que es donde se mira si alguien sospecha.
export class ReactionRelay {
  constructor(private readonly deps: ReactionRelayDeps) {}

  async relay(playerId: string, reactionId: string): Promise<void> {
    if (!this.deps.limiter.take(playerId)) {
      this.deps.log.debug("gesto descartado: demasiado seguido", { playerId, reactionId });
      return;
    }
    const reaction = await this.deps.catalog.find(reactionId);
    // Un id que no está en el catálogo es un cliente viejo —o alguien probando qué pasa—. Lo que NO
    // puede pasar es que salga a la mesa contenido que el servidor no reconoce: ahí se cae la
    // diferencia entre esto y un chat.
    if (!reaction) {
      this.deps.log.debug("gesto descartado: no está en el catálogo", { playerId, reactionId });
      return;
    }
    const sent = { fromPlayerId: playerId, reaction };
    this.deps.publish(sent);
    this.deps.onRelayed?.(sent);
  }
}
