import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// EL NOMBRE DEL ARCHIVO QUE SE EJECUTA está escrito en CUATRO lugares que no se importan
// entre sí —el bundler, los dos scripts de npm, el `CMD` de la imagen y el `script` de pm2—,
// y ninguno de los cuatro rompe el gate si se desincroniza: `tsc` no lee el Dockerfile,
// `vitest` no lee el `ecosystem.config.cjs`, y un `npm start` que apunta a un `dist/` que
// nadie generó falla recién al desplegar.
//
// Es exactamente la falla que truco pagó al partir el entrypoint (`be06148`): allá el
// síntoma fue una instancia que pm2 daba por levantada sin que el servidor escuchara nunca.
// Acá el síntoma sería más burdo —`Cannot find module`— pero igual de tardío: en el
// contenedor, no en el gate.
//
// Se miden los archivos como TEXTO y no importándolos: importar `tsup.config.ts` sería
// medir la mitad (el Dockerfile y el `.cjs` no son módulos de este proyecto), y una
// verificación que cubre la mitad de las puertas no cubre ninguna.

const ENTRYPOINT_SOURCE = "src/main.ts";
const ENTRYPOINT_BUNDLE = "dist/main.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("el entrypoint se llama igual en todos lados", () => {
  // EL ARCHIVO QUE CORRE está separado del que se IMPORTA (`app.config.ts`, que compone las
  // dos superficies y del que cuelga la suite entera). La separación es lo que le da al
  // apagado ordenado un lugar donde vivir que ningún test arrastre: registrar manejadores de
  // señal y de `message` desde un módulo que importan cuarenta y cinco archivos de test
  // dejaría cuarenta y cinco procesos de vitest peleándose el apagado.
  it("el bundler empaqueta src/main.ts", () => {
    expect(read("tsup.config.ts")).toContain(`"${ENTRYPOINT_SOURCE}"`);
  });

  it("los scripts de npm nombran el mismo archivo", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.start).toContain(ENTRYPOINT_BUNDLE);
    expect(scripts.dev).toContain(ENTRYPOINT_SOURCE);
  });

  it("la imagen y pm2 arrancan el mismo bundle", () => {
    expect(read("Dockerfile")).toContain(ENTRYPOINT_BUNDLE);
    expect(read("ecosystem.config.cjs")).toContain(ENTRYPOINT_BUNDLE);
  });

  // `.cjs` Y NO `.js`, y no es preferencia: el paquete es `"type": "module"`, así que un `.js`
  // se lee como ESM y ahí `module.exports` NO EXISTE. pm2 lee su configuración con `require`.
  // El síntoma sería un despliegue que no arranca, en la máquina de producción.
  it("la configuración de pm2 es CommonJS", () => {
    expect(read("ecosystem.config.cjs")).toContain("module.exports");
  });
});
