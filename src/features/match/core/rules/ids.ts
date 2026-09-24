// LOS IDENTIFICADORES CON LOS QUE SE HABLA DE UNA MESA, y viven acá por la misma razón que las
// fases y las fichas: son vocabulario del JUEGO. Una regla dice «es el turno de este jugador», y
// eso necesita nombrar al jugador sin necesitar el schema que lo guarda ni el motor que lo mueve.
//
// ERAN LA ÚLTIMA DEPENDENCIA QUE `rules/` TENÍA HACIA AFUERA. Con ellos adentro, el módulo no
// importa NADA de `core/` —ni del estado, ni del motor, ni de la config de la mesa—, que es la
// condición literal de la afirmación que su `index.ts` hace: que algún día viaje en un paquete que
// el cliente también consuma. Mientras estuvieran en `core/ids.ts`, "el paquete" era esta carpeta
// MÁS un archivo suelto de otra, y eso no es un paquete: es una carpeta con una nota al pie.
// `core/ids.ts` los re-exporta, así que la mudanza no le cambió el import a nadie.
export type PlayerId = string;

// DOS EQUIPOS Y NO N, y la unión cerrada es lo que lo sostiene: el 2P los reparte uno y uno, el 4P
// de a dos, y no hay modo de dominó con tres bandos. `opponentTeam` es un `=== "A" ? "B" : "A"`
// justamente porque el tipo se lo permite.
export type TeamId = "A" | "B";
