import type { Ref } from "@colyseus/schema";
import type { PlayerId } from "../ids.js";

// La audiencia es de DOMINIO: un JUGADOR o la mesa, nunca una conexión. Eso es lo que
// permite que la vista sea del ASIENTO y no del socket (spec §7.3).
//
// SON DOS Y NO TRES: no hay audiencia de EQUIPO, porque en dominó no existe ninguna
// mecánica que le muestre algo a tu compañero y no a la mesa. Truco tiene tres —el
// intercambio de carta entre compañeros, la flor, el pegado—, y de ahí venía la tercera
// rama en la primera redacción de este plan: una `case "TEAM"` inalcanzable, con un test
// afirmando que lanzaba. Estado especulativo con test propio.
//
// Si algún día apareciera un modo de dominó con señas legales entre compañeros, la rama
// se agrega acá y el compilador señala los dos sitios que la tienen que resolver.
export type Audience = { kind: "PLAYER"; playerId: PlayerId } | { kind: "ALL" };

// El dominio ordena "hacé público este nodo a esta audiencia"; el puerto hace el view.add.
// El dominio nunca toca client.view.
export interface SchemaVisibilityController {
  makePublic(node: Ref, audience: Audience): void;
  hide(node: Ref, audience: Audience): void;
}
