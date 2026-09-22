import type { z } from "zod";

// LO QUE SE CAMBIÓ, por sección y por campo, y nada más: un override es un APARTAMIENTO del valor con
// el que sale el código, nunca una config entera.
//
// Eso es lo que hace del parche un parche —lo que nadie tocó sigue al default, así que mover un
// default en un deploy le llega a todo el que no lo pisó— y lo que hace de volver atrás un BORRADO en
// vez de tener que saber cuál era el default. Portado de truco (`3cab0f8`).
export type SectionOverrides = Readonly<Record<string, unknown>>;
export type SettingsOverrides = Readonly<Record<string, SectionOverrides>>;

export const NO_OVERRIDES: SettingsOverrides = {};

// UNA PORCIÓN DE CONFIGURACIÓN que se puede editar con el servidor andando.
//
// Es un DESCRIPTOR y no un tipo de esta feature porque el mecanismo no conoce ninguna config: lo que
// empareja un nombre con una forma es el composition root, que es el único que ya conoce todas las
// features.
export interface SettingsSection {
  readonly name: string;
  // PARCIAL, para que un parche lleve un solo campo, y ESTRICTO, para que un campo no editable sea un
  // rechazo y nunca un descarte silencioso: un typo que contesta 200 y no hace nada es peor que un
  // error.
  readonly schema: z.ZodType<SectionOverrides>;
  // Los valores en vigor sin override encima, leídos AL PREGUNTAR y nunca capturados: el que
  // re-registra la base —la suite lo hace, a mitad de test— tiene que ganarle a un valor viejo.
  readonly defaults: () => object;
  // Los campos que un parche puede llevar. Viaja con la sección y no se lee del schema, para que el
  // que pregunta qué puede mover reciba una lista y no una adivinanza.
  readonly editable: readonly string[];
}
