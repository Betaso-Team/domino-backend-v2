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

// EL PISO DE NODE es lo MISMO que el nombre del entrypoint: está escrito en lugares que no se
// importan entre sí y ninguno rompe el gate al desincronizarse. `tsc` no lee el `engines`, y el
// `FROM node:22-alpine` del Dockerfile no lo lee nadie.
//
// Y tiene un modo de falla que ya cobró en truco: EL NODE DE pm2 ES EL DEL DEMONIO, no el de
// quien despliega ni el que corrió la suite. En su servidor el demonio corría con un node 20 del
// sistema mientras el CI y la imagen usaban el 22, y colyseus 0.18 pide 22. Por eso
// `ecosystem.config.cjs` acepta un intérprete explícito y `engines` dice el piso en voz alta:
// un `npm ci` con un node más viejo avisa, un pm2 con un node más viejo no.
const nodeMajorFloor = (range: string): number => {
  const match = /(\d+)/.exec(range);
  if (!match?.[1]) throw new Error(`no se pudo leer el piso de node de "${range}"`);
  return Number(match[1]);
};

describe("el piso de node se dice en voz alta y en todos lados", () => {
  // CONTRA LA DEPENDENCIA Y NO CONTRA UN NÚMERO ESCRITO A MANO: así un bump de colyseus que
  // suba SU piso pone esto rojo en el gate, que es el único lugar barato donde enterarse.
  it("`engines` no promete menos de lo que colyseus exige", () => {
    const nuestro = nodeMajorFloor(JSON.parse(read("package.json")).engines.node);
    const suyo = nodeMajorFloor(
      JSON.parse(read("node_modules/colyseus/package.json")).engines.node,
    );
    expect(nuestro).toBeGreaterThanOrEqual(suyo);
  });

  it("la imagen no construye con un node por debajo de ese piso", () => {
    const nuestro = nodeMajorFloor(JSON.parse(read("package.json")).engines.node);
    const imágenes = [...read("Dockerfile").matchAll(/FROM node:(\d+)/g)].map((m) => Number(m[1]));
    expect(imágenes.length).toBeGreaterThan(0);
    for (const mayor of imágenes) expect(mayor).toBeGreaterThanOrEqual(nuestro);
  });

  // pm2 tiene que poder recibir el intérprete: es la única de las cuatro puertas donde el node
  // no lo elige ni el repo ni la imagen.
  it("pm2 acepta un intérprete explícito", () => {
    expect(read("ecosystem.config.cjs")).toContain("interpreter");
  });
});
