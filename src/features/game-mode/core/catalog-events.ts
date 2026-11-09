import type { CatalogActor } from "./catalog";
import type { GameMode } from "./game-mode";

// LO QUE EL CATÁLOGO ANUNCIA DE CADA CAMBIO, para quien escuche (el servicio de notificaciones de
// Betaso Games): `domino.config.<entidad>.<acción>` en el exchange `betaso_games`, con cuándo y quién.
// El contrato está en `docs/api-y-mensajes.md`; cambiar un payload es cambiar un contrato publicado.
//
// NO VA EN LA MISMA TRANSACCIÓN QUE EL CAMBIO: Mongo no tiene transacciones en este despliegue. Se
// encola DESPUÉS de escribir, así que un proceso que muere entre las dos pierde ese aviso; para una
// notificación se acepta. Al revés nunca: no se anuncia nada que no se escribió.

export type ModeAction = "created" | "updated" | "deactivated" | "reactivated";

export type CatalogTopic =
  | `domino.config.shared_game_mode.${ModeAction}`
  | `domino.config.provider_game_mode.${ModeAction | "subscribed" | "unsubscribed" | "copied"}`
  | "domino.config.catalog_source.changed";

export interface CatalogEvent {
  readonly topic: CatalogTopic;
  readonly payload: Readonly<Record<string, unknown>>;
}

// QUIEN LOS RECIBE. Nunca hace fallar la mutación que ya se escribió: el adaptador traga y loguea
// lo que no pudo encolar.
export interface CatalogEvents {
  announce(event: CatalogEvent): Promise<void>;
}

export const NO_CATALOG_EVENTS: CatalogEvents = { announce: async () => {} };

// El admin por su nombre (el `sub` de su token, o `ADMIN_API_KEY`); sin nombre, el sistema.
function actorOf(actor: CatalogActor): Readonly<Record<string, string>> {
  return actor.name ? { kind: "admin", name: actor.name } : { kind: "system" };
}

function base(actor: CatalogActor, at: Date) {
  return { gameSlug: "domino", occurredAt: at.toISOString(), actor: actorOf(actor) };
}

/** Un modo creado, editado, dado de baja o reactivado: compartido o propio de un proveedor. */
export function modeEvent(
  actor: CatalogActor,
  mode: GameMode,
  action: ModeAction,
  at: Date,
): CatalogEvent {
  const owner = mode.ownerProviderId;
  return owner === null
    ? {
        topic: `domino.config.shared_game_mode.${action}`,
        payload: { ...base(actor, at), modeId: mode.uuid, name: mode.name },
      }
    : {
        topic: `domino.config.provider_game_mode.${action}`,
        payload: { ...base(actor, at), providerId: owner, modeId: mode.uuid, name: mode.name },
      };
}

/** Un proveedor se suscribió a un compartido, o se dio de baja. */
export function subscriptionEvent(
  actor: CatalogActor,
  mode: GameMode,
  providerId: string,
  change: "add" | "remove",
  at: Date,
): CatalogEvent {
  return {
    topic: `domino.config.provider_game_mode.${change === "add" ? "subscribed" : "unsubscribed"}`,
    payload: { ...base(actor, at), providerId, modeId: mode.uuid, name: mode.name },
  };
}

/** Se copiaron compartidos como propios de un proveedor. */
export function copiesEvent(actor: CatalogActor, providerId: string, at: Date): CatalogEvent {
  return {
    topic: "domino.config.provider_game_mode.copied",
    payload: { ...base(actor, at), providerId },
  };
}

/** Cambió la fuente del catálogo de un proveedor. */
export function sourceEvent(
  actor: CatalogActor,
  providerId: string,
  source: string,
  at: Date,
): CatalogEvent {
  return {
    topic: "domino.config.catalog_source.changed",
    payload: { ...base(actor, at), providerId, source },
  };
}
