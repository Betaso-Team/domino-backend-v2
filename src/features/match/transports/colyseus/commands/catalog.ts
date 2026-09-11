import type { Command, CommandName } from "../../../core/command.js";
import type { MatchEvent } from "../../../core/events.js";
import { UnknownCommandError } from "../errors.js";
import type { MessageDecoder } from "./decoders.js";

type Decoders = { readonly [N in CommandName]: MessageDecoder<N> };
type Commands = { readonly [N in CommandName]: Command<N, MatchEvent> };

export class CommandCatalog {
  constructor(
    private readonly decoders: Decoders,
    private readonly commands: Commands,
  ) {}

  // LA FRONTERA ANTI-TRAMPA. Object.hasOwn y NO `in`: con `in`, los nombres
  // heredados de Object.prototype la pasan (ver el test).
  //
  // Se resuelve sobre el mapa de DECODERS, así que la lista de verbos aceptados y
  // la frontera son la misma cosa: un verbo sin decoder no puede llegar por el cable.
  accepts(type: string): type is CommandName {
    return Object.hasOwn(this.decoders, type);
  }

  decoder(type: string): MessageDecoder<CommandName> {
    if (!this.accepts(type)) throw new UnknownCommandError(type);
    return this.decoders[type];
  }

  command(type: string): Command<CommandName, MatchEvent> {
    if (!this.accepts(type)) throw new UnknownCommandError(type);
    return this.commands[type];
  }
}
