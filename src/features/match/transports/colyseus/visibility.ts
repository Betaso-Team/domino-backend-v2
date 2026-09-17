import type { Ref, StateView } from "@colyseus/schema";
import { InvariantViolationError } from "../../core/engine/errors";
import type { Audience, SchemaVisibilityController } from "../../core/engine/visibility";
import type { PlayerId } from "../../core/ids";

export class StateViewVisibilityController implements SchemaVisibilityController {
  constructor(private readonly views: ReadonlyMap<PlayerId, StateView>) {}

  makePublic(node: Ref, audience: Audience): void {
    for (const view of this.resolve(audience)) view.add(node);
  }

  hide(node: Ref, audience: Audience): void {
    for (const view of this.resolve(audience)) view.remove(node);
  }

  private resolve(audience: Audience): Iterable<StateView> {
    if (audience.kind === "ALL") return this.views.values();
    const view = this.views.get(audience.playerId);
    if (!view) {
      throw new InvariantViolationError(`sin vista para el asiento ${audience.playerId}`);
    }
    return [view];
  }
}

// La vista pertenece al ASIENTO, no al socket. La sala crea todas las vistas antes de
// que haya conexiones: así un asiento desconectado recibe revelaciones y al reconectar
// sigue viendo su propia mano. Este adaptador no necesita conocer a Client.
