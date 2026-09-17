// Los dos identificadores se declaran en `rules/ids` —son vocabulario del juego, no del motor ni
// del schema— y se re-exportan acá, que es de donde los importaba todo el mundo. Ver la cabecera
// de ese archivo: con ellos adentro, `rules/` dejó de importar nada de `core/`.
export type { PlayerId, TeamId } from "./rules/ids";
