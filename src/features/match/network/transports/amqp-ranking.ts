import type { AmqpDelivery } from "@/shared/amqp.js";
import type { RankingFeed, RankingParticipation } from "../standings.js";

// LA COLA DEL RANKING del backend principal, con el envoltorio de patrón de NestJS —del otro lado
// hay un `@EventPattern` y no un consumidor crudo, así que sin el envoltorio el mensaje se
// descarta en silencio—. Los tres nombres son de v1
// (`Betaso-Domino-Backend/src/storage/rabbitmq/publisher.ts:12`,
// `src/ranking/ranking.service.ts:82`) y no se inventa ninguno.
const RANKING_QUEUE = "rankings_queue";
const PATTERN = "ranking.save-participation";

// QUÉ RANKING. El backend principal tiene varios activos a la vez —uno por moneda, por
// temporada— y resuelve cuál con este tipo más la moneda; acá alcanza con decir cuál es el juego.
const RANKING_TYPE = "domino-ranking";

export class AmqpRankingFeed implements RankingFeed {
  constructor(private readonly publisher: AmqpDelivery) {}

  async won(entry: RankingParticipation): Promise<void> {
    await this.publisher.publishPattern(RANKING_QUEUE, PATTERN, {
      rankingType: RANKING_TYPE,
      currency: entry.currency,
      // EL NOMBRE DEL CAMPO ES `userId` DEL OTRO LADO y acá se llama `userUuid`: la traducción es
      // la mitad de lo que hace este archivo, igual que el `uuid` → `gameModeId` del catálogo. Lo
      // que viaja es la identidad de PLATAFORMA, nunca el `seat-N` interno de la mesa.
      userId: entry.userUuid,
      username: entry.username,
      profilePicture: entry.profilePicture,
      multiplier: entry.multiplier,
      // SE COPIA A UN ARREGLO PROPIO. La lista que entra es `readonly` y este objeto se serializa
      // enseguida, así que no cambia nada funcional; lo que evita es que un `JSON.stringify` de un
      // `ArraySchema` termine acá el día que el llamador pase el nodo del árbol en vez de una
      // proyección.
      opponentIds: [...entry.opponentUuids],
      // SOLO SI HUBO AUMENTO, con el `...` condicional: v1 manda la clave únicamente cuando
      // `acceptedBetLevel > 0`, y un `betIncrease: undefined` se serializa como clave AUSENTE en
      // JSON —así que daría lo mismo—, pero decirlo explícito es lo que deja leer la condición
      // acá en vez de deducirla del comportamiento de `JSON.stringify`.
      ...(entry.betIncrease && { betIncrease: entry.betIncrease }),
    });
  }
}
