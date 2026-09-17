import type { Command, CommandName, CommandPayload } from "../../../core/command";
import type { MatchEvent } from "../../../core/events";
import type { MessageDecoder } from "../messages";

type Decoders = { readonly [N in CommandName]: MessageDecoder<CommandPayload<N>> };
type Commands = { readonly [N in CommandName]: Command<N, MatchEvent> };

// LOS DOS MAPAS DEL MOTOR, que es lo único que esta clase fue siempre. **`accepts()` se
// fue al router** (`../messages.ts`): la frontera del socket ya no es asunto del catálogo
// de verbos, porque el conjunto de mensajes que el cliente puede mandar dejó de ser el
// conjunto de verbos del dominó.
//
// Con `accepts` se fue también el `Object.hasOwn` que lo cuidaba —`'toString' in decoders`
// es `true`, y un mensaje de una línea mataba la tabla—: el router usa un `Map`, que no
// tiene prototipo que esquivar. El test de esos nombres NO se borra, se mueve: lo que fija
// es la propiedad, no cómo se consigue.
//
// LO QUE SÍ SE CONSERVA, y es la mitad del valor: los dos tipos mapeados sobre
// `CommandName`. Son los que hacen imposible sumar un verbo al motor y olvidarse de
// rutearlo — sin ellos, `buildRouter` compilaría con cuatro de cinco.
export class CommandCatalog {
  constructor(
    private readonly decoders: Decoders,
    private readonly commands: Commands,
  ) {}

  // Tipadas contra `CommandName` y NO contra `string`, así que no pueden fallar y no
  // lanzan. Lo que antes obligaba al `throw` era recibir lo que venía del cable; el cable
  // ahora muere en el router.
  decoder<N extends CommandName>(name: N): MessageDecoder<CommandPayload<N>> {
    return this.decoders[name];
  }

  command<N extends CommandName>(name: N): Command<N, MatchEvent> {
    return this.commands[name];
  }

  // Las claves del mapa de decoders SON la lista de verbos: `buildRouter` la recorre para
  // registrar uno por uno, de modo que agregar un verbo al motor lo rutea solo.
  names(): readonly CommandName[] {
    return Object.keys(this.decoders) as CommandName[];
  }
}
