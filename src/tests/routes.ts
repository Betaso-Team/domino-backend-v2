import type { Router } from "express";

// LAS RUTAS DE UN ROUTER, EN EL ORDEN EN QUE EXPRESS LAS VA A PROBAR, como `"GET /path"`. Aplana los
// routers anidados, que es como cada feature compone sus responsabilidades (`transports/http/
// register.ts`).
//
// Existe porque QUÉ rutas llegan a existir y EN QUÉ ORDEN es una decisión de wiring que un servidor
// no muestra: dos órdenes distintos pueden contestar igual hoy y dejar de hacerlo con la ruta que se
// agregue mañana. Lee el `stack` del router de la express 5.2 instalada —`layer.route` para una ruta,
// `layer.handle.stack` para un router montado—, que es una estructura interna: si una versión nueva
// la cambia, este helper devuelve `[]` y los tests que lo usan se ponen rojos, que es lo correcto.
interface Layer {
  readonly route?: { readonly path: string; readonly methods: Record<string, boolean> };
  readonly handle: { readonly stack?: readonly Layer[] };
}

export function routesOf(router: Router): string[] {
  const walk = (stack: readonly Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route) {
        return Object.keys(layer.route.methods).map(
          (method) => `${method.toUpperCase()} ${layer.route?.path}`,
        );
      }
      return layer.handle.stack ? walk(layer.handle.stack) : [];
    });
  return walk((router as unknown as { stack: readonly Layer[] }).stack);
}
