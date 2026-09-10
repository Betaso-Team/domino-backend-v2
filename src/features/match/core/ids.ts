// Sin consumidores todavía dentro de esta tarea (Tarea 4): son los identificadores que
// las tareas siguientes —génesis, proyecciones, engine— usan para tipar `playerId` /
// `teamId` en vez de repetir `string` a mano. Viven acá, y no junto a `state/`, porque no
// son Schema: son los tipos que el CÓDIGO ALREDEDOR del árbol usa para hablar de él.
export type PlayerId = string;
export type TeamId = "A" | "B";
