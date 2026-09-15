import { MemoryGameModeOutbox } from "./memory-outbox.js";
import { describeGameModeOutboxContract } from "./tests/outbox-contract.js";
import { mutableClock } from "./tests/repository-contract.js";

// SÓLO EL CONTRATO, y eso es el archivo entero. `MemoryGameModeOutbox` no tiene nada que el puerto no
// prometa —no hay documento BSON, ni índices, ni colección—, así que todo lo que se le puede medir ya
// está escrito una vez en `tests/outbox-contract.ts` y corre también contra el adaptador Mongo. Un
// `it` propio acá sería la primera línea de la deriva que el contrato compartido existe para impedir.

describeGameModeOutboxContract("MemoryGameModeOutbox", () => {
  const clock = mutableClock();
  return { outbox: new MemoryGameModeOutbox(clock), clock };
});
