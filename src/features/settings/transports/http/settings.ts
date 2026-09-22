import { requireAdminPanelKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import type { Logger } from "@/shared/logger";
import { type Request, Router } from "express";
import type { SectionOverrides, SettingsSection } from "../../sections";
import type { PolledSettingsSignal } from "../../signal";
import type { SettingsWriter } from "../../store";

// El prefijo de las palancas internas del dominó, el mismo del mantenimiento
// (`/internal/lobby/maintenance`). NO es `/settings` a secas, y no por estética: v1 sirve un
// `GET /settings` PÚBLICO con el mantenimiento y sus plazos, y reusar el nombre con otro contrato y
// detrás de una llave rompería en silencio al cliente que todavía lo lea.
export const SETTINGS_ROUTE = "/internal/settings";

interface SectionDTO {
  name: string;
  // Lo que está en vigor: los defaults con los overrides encima.
  effective: object;
  // Sólo lo que se aparta de ellos, para que un panel muestre qué se tocó.
  overrides: SectionOverrides;
  editable: readonly string[];
}

export interface SettingsRoutesDeps {
  readonly sections: readonly SettingsSection[];
  readonly signal: PolledSettingsSignal;
  readonly writer: SettingsWriter;
  readonly adminPanelApiKey: string | undefined;
  readonly log: Logger;
}

// LEER Y EDITAR LA CONFIGURACIÓN DEL JUEGO con el servidor andando, para mover un plazo sin deploy.
// Portado de truco (`3cab0f8`).
//
// TODO DETRÁS DE LA LLAVE, las lecturas incluidas: no son números que un jugador pida —los que
// necesita viajan con el estado de cada mesa— y la lista de lo editable es un mapa de lo que se puede
// romper. Y SIN LLAVE NO SE REGISTRA NADA, igual que el catálogo y el mantenimiento: una palanca que
// mueve los plazos de todas las mesas no puede nacer pública por una variable ausente.
//
// QUÉ ALCANZA UNA ESCRITURA, y cuándo. El proceso que la atiende se refresca en el acto, así que
// contesta con lo que va a usar de verdad. El resto del clúster converge en una pasada
// (`SETTINGS_POLL_MS`). Y una mesa YA EN JUEGO se queda con la config con la que nació, porque la sala
// la fotografía al crearse: los números de una mesa no se mueven debajo de los que están jugando.
export function settingsRoutes(deps: SettingsRoutesDeps): Router {
  const router = Router();
  const { sections, signal, writer, adminPanelApiKey, log } = deps;
  if (!adminPanelApiKey) {
    log.warn("configuración en caliente APAGADA: sin BETASO_ADMIN_PANEL_API_KEY no se registra", {
      route: `${SETTINGS_ROUTE}/*`,
    });
    return router;
  }
  const admin = requireAdminPanelKey(adminPanelApiKey);

  const dtoOf = (section: SettingsSection): SectionDTO => ({
    name: section.name,
    effective: signal.effective(section.name),
    overrides: signal.overrides(section.name),
    editable: section.editable,
  });

  router.get(SETTINGS_ROUTE, admin, (_req, res) => {
    res.json(sections.map(dtoOf));
  });

  for (const section of sections) {
    const route = `${SETTINGS_ROUTE}/${section.name}`;
    router.get(route, admin, (_req, res) => {
      res.json(dtoOf(section));
    });

    router.patch(
      route,
      admin,
      validated({ body: section.schema }, async ({ body }, res) => {
        await writer.save(section.name, body);
        // ANTES de contestar, así lo que sale es lo que este proceso va a usar de acá en más.
        await signal.check();
        log.info("configuración editada", {
          section: section.name,
          patch: body,
          ip: ipOf(res.req),
        });
        res.json(dtoOf(section));
      }),
    );

    router.delete(route, admin, async (req, res, next) => {
      try {
        await writer.clear(section.name);
        await signal.check();
        log.info("configuración devuelta a los defaults", { section: section.name, ip: ipOf(req) });
        res.json(dtoOf(section));
      } catch (error) {
        next(error);
      }
    });
  }

  // DESPUÉS de las secciones, así un nombre que nadie cableó contesta en el mismo idioma que el resto
  // en vez de caer al HTML de Express.
  router.all(`${SETTINGS_ROUTE}/:section`, admin, (_req, res) => {
    res.status(404).json({ code: "SETTINGS_SECTION_NOT_FOUND" });
  });
  return router;
}

// La llave autoriza pero no identifica, así que la dirección es el único rastro que deja un cambio.
const ipOf = (req: Request): string | undefined => req.ip;
