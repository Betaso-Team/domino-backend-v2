import type { Command, CommandName, CommandPayload } from "../../../core/command";
import type { MatchEvent } from "../../../core/events";
import type { MatchHistory } from "../../../network";
import type { MessageHandler } from "../messages";

// QUÉ SIGNIFICA ATENDER UN VERBO DEL DOMINÓ, en un solo lugar. Son tres pasos y son los
// mismos para todos, así que se componen una vez y no se escriben a mano en la sala.
//
// **Estaba desplegado dentro de la room**, junto a la frontera y al decodificado, y por eso
// "mensaje del cliente" y "verbo del motor" no se podían distinguir: los cinco pasos eran
// uno solo. Acá los tres que son del verbo quedan juntos y con nombre, y la sala se queda
// con rutear.
//
// Y de paso queda dicho algo que antes solo se veía leyendo la room: **el historial es del
// VERBO, no del mensaje**. Se graba lo que se JUGÓ. Una reacción entra por el mismo cable y
// no se graba, porque no es un acto de la partida.
export class CommandHandler<N extends CommandName> implements MessageHandler<CommandPayload<N>> {
  constructor(
    private readonly name: N,
    private readonly command: Command<N, MatchEvent>,
    private readonly history: MatchHistory,
    private readonly notify: (events: readonly MatchEvent[]) => void,
  ) {}

  handle(payload: CommandPayload<N>): void {
    // SÍNCRONO, y el tipo lo dice: los comandos del motor lo son por contrato (§`Command`).
    // Que el `MessageHandler` admita una promesa es para los mensajes que NO son del motor;
    // este handler no la usa, y que no la use se ve en la firma.
    const events = this.command.execute(payload);
    // El comando se registra ANTES de notificar, y eso es lo que ordena el historial:
    // primero el acto, después los hechos que provocó. Solo se registra lo que EJECUTÓ — si
    // `execute` lanzó, no llegamos acá: una jugada rechazada es rastro antifraude, no
    // historia de la partida.
    //
    // La fuente es `"PLAYER"` por construcción y no un parámetro: lo que entra por el cable
    // lo mandó un jugador. Los actos del sistema —el retiro por vencimiento de turno— no
    // pasan por acá, y que no puedan declararse jugador desde esta clase es la mitad del
    // valor de tenerla.
    this.history.command("PLAYER", this.name, payload);
    this.notify(events);
  }
}
