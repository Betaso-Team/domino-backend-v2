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

// EL ARRANQUE DE LOS SERVICIOS DE FONDO es un contrato entre dos archivos que no se leen entre
// sí, que es de lo que trata este archivo entero. `src/main.ts` es el que CORRE y `src/app.config.ts`
// el que se IMPORTA; el emparejador, el mantenimiento, el censo y el vigilante de torneos viven en
// el container y alguien tiene que encenderlos.
//
// SE MIDE PORQUE EL OLVIDO NO FALLA, CUELGA. Sin `startServices()` el servidor levanta, acepta
// sockets, contesta el HTTP y crea salas — y nadie se empareja nunca, porque la cola no tiene quién
// la mire. No hay excepción, no hay log y el `/health` sigue en 200.
describe("los servicios de fondo los enciende el que corre", () => {
  const main = read(ENTRYPOINT_SOURCE);

  it("main.ts llama a startServices antes de escuchar", () => {
    expect(main).toContain("startServices()");
    expect(main.indexOf("startServices()")).toBeLessThan(main.indexOf("listen(app"));
  });

  it("y los apaga al dejar de aceptar partidas", () => {
    expect(main).toContain("stopAcceptingMatches()");
  });
});

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

  // LA CUARTA PUERTA, y la que más caro sale al revés: el CI es lo ÚNICO que verifica antes de
  // que algo toque un servidor, así que verificar con un node por debajo del piso es un verde que
  // no prueba lo que dice probar. Y es la puerta que menos se mira — nadie abre un workflow para
  // revisar un número entre comillas.
  //
  // Se lee el YAML como TEXTO, igual que el resto de este archivo: parsearlo pediría una
  // dependencia nueva para medir una línea. La forma es la que escribe `actions/setup-node`.
  it("el CI no verifica con un node por debajo de ese piso", () => {
    const nuestro = nodeMajorFloor(JSON.parse(read("package.json")).engines.node);
    const versiones = [
      ...read(".github/workflows/ci.yml").matchAll(/node-version:\s*'?(\d+)/g),
    ].map((m) => Number(m[1]));
    expect(versiones.length).toBeGreaterThan(0);
    for (const mayor of versiones) expect(mayor).toBeGreaterThanOrEqual(nuestro);
  });

  // pm2 tiene que poder recibir el intérprete: es la única de las cuatro puertas donde el node
  // no lo elige ni el repo ni la imagen.
  it("pm2 acepta un intérprete explícito", () => {
    expect(read("ecosystem.config.cjs")).toContain("interpreter");
  });
});

// EL ALIAS `@/` ESTÁ DECLARADO EN DOS LUGARES QUE NO SE LEEN ENTRE SÍ, y tiene un TERCER
// requisito que no es una declaración sino un archivo presente. Es el mismo modo de falla que el
// nombre del entrypoint —nada de esto rompe el gate al desincronizarse— y se mide igual, como
// texto.
//
// Las dos declaraciones:
//   · `tsconfig.json` → de ahí lo leen `tsc`, `tsup`/esbuild, `depcruise` (por su
//     `options.tsConfig`) y `tsx` (dev, replay, smokes).
//   · `vitest.config.ts` → Vite NO mira el tsconfig. Sin esa línea el typecheck queda verde y la
//     suite entera no resuelve un solo import.
//
// El tercero está medido abajo y es el único que no avisa en ninguna herramienta local.
describe("el alias `@/` está declarado donde cada herramienta lo busca", () => {
  it("el tsconfig mapea `@/*` a `src/*`", () => {
    const paths = JSON.parse(read("tsconfig.json")).compilerOptions.paths as Record<
      string,
      string[]
    >;
    expect(paths["@/*"]).toEqual(["./src/*"]);
  });

  // Se mide como TEXTO y no importando la config: importarla la ejecutaría —y con ella el plugin
  // de Vite— para leer un valor que está escrito en una línea.
  it("vitest declara el mismo alias, porque Vite no lee el tsconfig", () => {
    const source = read("vitest.config.ts");
    expect(source).toContain('alias: { "@"');
    expect(source).toContain("./src");
  });

  // LA TERCERA PUERTA, y la única que no falla en ninguna herramienta local: el smoke del deploy
  // corre con `tsx` DENTRO DE LA IMAGEN, así que necesita el `tsconfig.json` ahí adentro. Lo trae
  // el `COPY . .` de la etapa `build`, y esta etapa deriva de ella.
  //
  // Lo que rompe es derivarla de `runtime` para adelgazarla —ahí solo hay `dist/` y
  // `package*.json`— o sumar el tsconfig al `.dockerignore`. Las dos cosas dan un
  // `ERR_MODULE_NOT_FOUND: Cannot find package '@/features'` (verificado a mano forzando un
  // tsconfig sin `paths`), que no dice que falta un archivo de configuración.
  it("la imagen del smoke deriva de una etapa que tiene el tsconfig", () => {
    expect(read("Dockerfile")).toContain("FROM build AS smoke-client");
    // El `.dockerignore` no lo excluye. Se busca la línea EXACTA: `tsconfig` a secas también
    // matchearía el comentario que lo menciona.
    const ignored = read(".dockerignore")
      .split(/\r?\n/)
      .map((line) => line.trim());
    expect(ignored).not.toContain("tsconfig.json");
    expect(ignored).not.toContain("*.json");
  });
});
