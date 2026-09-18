import type { PlayerId } from "../../core/ids";
import { UnknownCommandError } from "./errors";

// LA FRONTERA DEL SOCKET, y los tres actores que la componen. Existe porque hasta acá
// "mensaje que el cliente manda" y "verbo del dominó" eran el mismo conjunto por
// construcción: el `type` del mensaje ERA un `CommandName`. Mientras todo lo que entraba
// fuera una jugada, la coincidencia no molestaba; el primer mensaje que es lo uno sin ser
// lo otro —una reacción, mañana un chat— la rompe.
//
// Lo que se separó no es el mensaje: es que atender cualquier cosa que llega por el cable
// tiene SIEMPRE la misma forma, y lo único que cambia es el efecto.
//
//    raw ──► MessageDecoder<P> ──payload──► MessageHandler<P> ──► efecto
//               valida y tipa                 hace el trabajo
//                      ▲                            ▲
//                      └────────  MessageRouter  ───┘
//                           los empareja y despacha
//
// Los verbos del dominó dejan de ser el conjunto y pasan a ser elementos de él.

// VALIDA + MAPEA. Es la ÚNICA pieza del repo cuyo contrato acepta `unknown`: de acá para
// adentro nadie ve el cable. El `playerId` NO viene en el mensaje —el cliente jamás manda
// su propio id— y se inyecta acá desde la identidad ya verificada.
export interface MessageDecoder<P> {
  decode(raw: unknown, playerId: PlayerId): P;
}

// QUÉ SE HACE con lo ya validado. Nunca ve el cable, y por eso su payload está tipado de
// verdad.
//
// Puede ser asíncrono, y ahí está la otra mitad de lo que esta separación permite: los
// comandos del motor son SÍNCRONOS por contrato (§`Command`), pero no todo lo que un
// cliente manda es un comando del motor —una reacción tiene que resolver un catálogo
// remoto—. Lo asíncrono es la envoltura de transporte, nunca el motor.
export interface MessageHandler<P> {
  handle(payload: P, playerId: PlayerId): void | Promise<void>;
}

// El par ya emparejado. No sale del módulo: el payload tipado vive entre el decoder y su
// handler, y afuera solo queda la llamada preparada.
type Dispatch = (raw: unknown, playerId: PlayerId) => void | Promise<void>;

// EL ROUTER: el único que conoce a los dos, y la frontera anti-trampa entera. Sabe qué
// tipos se pueden mandar y a quién le tocan; no sabe qué son ni de qué capa vienen.
export class MessageRouter {
  private readonly routes = new Map<string, Dispatch>();

  // Registra QUIÉN decodifica y QUIÉN atiende un tipo. Los dos entran JUNTOS porque se
  // eligen juntos, y eso es lo que ata el payload: `P` los relaciona acá y en ningún otro
  // lado hace falta nombrarlo.
  //
  // Y es lo que hace **imposible atender algo sin haberlo validado antes**: no existe otro
  // camino de un `raw` a un handler que el que se arma en esta línea. No es disciplina, es
  // que no hay otra puerta.
  on<P>(type: string, decoder: MessageDecoder<P>, handler: MessageHandler<P>): this {
    // Dos dueños para un mismo tipo es un bug de composición, y silencioso: el segundo
    // pisaría al primero y un verbo dejaría de llegar sin que nada se queje. Los mapas que
    // esto reemplaza no podían tenerlo —un objeto literal con la clave repetida no
    // compila—, así que la garantía se repone acá.
    if (this.routes.has(type)) throw new Error(`mensaje duplicado en el router: ${type}`);
    this.routes.set(type, (raw, playerId) =>
      handler.handle(decoder.decode(raw, playerId), playerId),
    );
    return this;
  }

  // DESPACHA, o rechaza. La lista y la frontera son la misma cosa —se pregunta sobre el
  // mismo `Map` del que sale el dispatch—, así que no hay dos tablas que se puedan
  // desincronizar.
  //
  // Un `Map` además cierra por construcción el agujero del prototipo que el catálogo de
  // verbos tenía que esquivar con `Object.hasOwn`: `routes.get('toString')` es `undefined`,
  // no una función heredada. La prueba de esos tipos sigue existiendo igual, para fijar la
  // propiedad.
  route(type: string, raw: unknown, playerId: PlayerId): void | Promise<void> {
    const dispatch = this.routes.get(type);
    if (!dispatch) throw new UnknownCommandError(type);
    return dispatch(raw, playerId);
  }
}
