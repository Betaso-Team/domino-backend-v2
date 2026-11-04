import { validated } from "@/shared/http/validated";
import { Router } from "express";
import type { ReactionCatalog } from "../catalog";

export const REACTIONS_ROUTE = "/reactions";

// CINCO MINUTOS EN CUALQUIER CACHÉ: la lista cambia con un deploy, no con el panel, y es la misma
// para todos los jugadores de todos los proveedores.
const PUBLIC_CACHE = "public, max-age=300";

// LA LISTA DE GESTOS, pública y sin credencial: no dice nada de nadie. El front la pide para dibujar
// el selector; lo que de verdad valida es la sala, que vuelve a buscar cada id en el mismo catálogo.
export function reactionsHttp({ catalog }: { readonly catalog: ReactionCatalog }): Router {
  return Router().get(
    REACTIONS_ROUTE,
    validated({}, async (_input, response) => {
      const packs = await catalog.packs();
      response.set("Cache-Control", PUBLIC_CACHE).json(packs);
    }),
  );
}
