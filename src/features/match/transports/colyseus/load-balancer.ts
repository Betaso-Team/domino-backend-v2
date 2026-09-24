import { matchMaker } from "colyseus";

// EN QUÉ PROCESO SE ABRE LA PARTIDA SIGUIENTE. Con una sola instancia esto no se nota —el
// default de Colyseus elige el de menos salas igual—; con varias es lo que decide si el trabajo
// queda repartido o si todo cae en el nodo al que el balanceador de HTTP mandó el pedido.
//
// VIVE ACÁ, AL LADO DE LA SALA, porque es el otro archivo que necesita `matchMaker`, y tenerlos
// juntos es lo que mantiene al resto del repo sin saber que Colyseus existe. El composition root
// (`src/app.config.ts`) lo entrega; no lo importa nadie más.
export class NoProcessAvailableError extends Error {
  constructor() {
    super("no hay ningún proceso disponible para abrir la partida");
    this.name = "NoProcessAvailableError";
  }
}

// LO QUE UN PROCESO ANUNCIA DE SÍ MISMO: los tres campos de `matchMaker.stats.fetchAll()`
// (`@colyseus/core/build/Stats.d.ts`), reescritos acá para que EL CRITERIO SE PUEDA LEER —y
// probar— SIN COLYSEUS DE POR MEDIO. Es la misma separación con la que el motor no conoce el
// transporte: la decisión es una función pura sobre una lista, y la lectura es de quien la llame.
export type ProcessLoad = { processId: string; roomCount: number; ccu: number };

// MENOS SALAS PRIMERO, Y A IGUALDAD MENOS JUGADORES. Las salas pesan más que los jugadores
// porque cada una trae su propio bucle de temporizadores —turno, reserva de tiempo extra,
// ventana de reparto, presentación— y su propio árbol sincronizado: dos mesas de dos cuestan más
// que una de cuatro.
export function leastLoaded(processes: readonly ProcessLoad[]): string {
  // Copia antes de ordenar: la lista que llega es la que `matchMaker.stats` acaba de leer, y
  // `sort` muta en el lugar.
  const [best] = [...processes].sort((a, b) =>
    a.roomCount !== b.roomCount ? a.roomCount - b.roomCount : a.ccu - b.ccu,
  );
  // Sin candidatos NO se elige "el de siempre". Un clúster que no anuncia ningún proceso es un
  // presence vacío o recién arrancado, y abrir ahí una partida sería abrirla en ningún lado: el
  // jugador recibiría una reserva de asiento contra una sala que nunca existió.
  if (!best) throw new NoProcessAvailableError();
  return best.processId;
}

export async function selectProcessIdToCreateRoom(): Promise<string> {
  // Las estadísticas salen del PRESENCE, así que esta lista es la del clúster y no la de este
  // proceso. Sin un presence compartido siempre habría un solo candidato —uno mismo—, que es
  // justamente el comportamiento correcto de una instancia sola.
  return leastLoaded(await matchMaker.stats.fetchAll());
}
