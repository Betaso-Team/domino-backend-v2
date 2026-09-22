import { type SchemaType, schema, t } from "@colyseus/schema";

/**
 * LA NEGOCIACIÓN DE LA REVANCHA, y es una RAMA NULA de `MatchState`: ausente significa que no
 * hay revancha en juego —ni todavía ni nunca más—, y presente que la ventana está viva.
 *
 * Qué caso es cada uno lo dice `MatchState.phase`, no un campo de acá. Es "un eje, un campo":
 * v1 tiene su propio `RematchPhase` (`closed`/`open`/`pending`/`accepted`) porque su estado de
 * partida no tiene dónde ponerlo; acá las tres fases vivas ya están en `MatchPhase` y la cuarta
 * —`closed`— es este nodo ausente. Duplicarlo daría dos fuentes que pueden discrepar sobre lo
 * mismo, que es exactamente lo que el eje único evita.
 *
 * LO QUE SÍ GUARDA es lo que la fase no puede decir, y son cuatro cosas distintas:
 */
export const RematchState = schema(
  {
    /**
     * SI EL BOTÓN SE PUEDE APRETAR, y viaja al cliente a propósito.
     *
     * Es lo único de este nodo que no es del juego sino de la PLATAFORMA: lo escribe la red
     * (saldo de los dos, antifraude, tope de la cadena) y el motor no lo calcula ni lo
     * consulta para decidir nada — lo publica.
     *
     * Y se publica en vez de derivarse porque el cliente NO PUEDE derivarlo: su fuente está
     * del otro lado de tres llamadas de red. Es el mismo criterio que deja pasar a
     * `Hand.tileCount`. Sin esto el front tendría dos opciones, las dos malas: mostrar el
     * botón siempre y que el jugador descubra apretando que no tiene saldo, o esconderlo
     * siempre y que nadie pida revancha nunca.
     *
     * Arranca en `false` porque la respuesta tarda: hasta que la red conteste, la ventana
     * está abierta y el botón apagado. Equivocarse hacia el lado cerrado cuesta una pantalla;
     * hacia el otro cuesta abrir una mesa que uno de los dos no puede pagar.
     */
    eligible: t.boolean().default(false),
    /** Quién pidió. `""` mientras nadie pidió, o sea durante toda `REMATCH_WINDOW`. */
    requesterId: t.string().default(""),
    /**
     * A QUIÉN LE TOCA RESPONDER cuando hay UNO SOLO, que es siempre en 2P. Con más de un
     * respondedor queda en `""` y el front usa `acceptedIds`.
     *
     * Es DERIVABLE de `requesterId` más la lista de jugadores, así que rompe la regla de no
     * guardar campos derivados — y es de v1, que lo expone "por comodidad del front". Se
     * conserva porque derivarlo del lado del cliente exige saber que el que no pidió es el que
     * responde, que es una regla del juego viajando en la UI. El costo es un `string` por mesa.
     */
    responderId: t.string().default(""),
    /**
     * LOS QUE YA ACEPTARON, sin contar al que pidió. Es un ARREGLO y no un contador, y no es
     * para el 4P de mañana: es para el front de hoy, que con dos jugadores necesita distinguir
     * «ya acepté, espero al resto» de «me están preguntando» — y eso es pertenencia, no cardinal.
     *
     * Que además deje el 4P resuelto es la consecuencia, no el motivo: la regla «todos los que
     * no pidieron tienen que aceptar» se escribe igual para uno que para tres.
     */
    acceptedIds: t.array("string"),
  },
  "RematchState",
);
export type RematchState = SchemaType<typeof RematchState>;
