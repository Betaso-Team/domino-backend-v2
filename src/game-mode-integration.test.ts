import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// EL CONTRATO ESTÁTICO DE LA CERTIFICACIÓN, y existe porque lo que mide está del otro lado de
// Docker. Este archivo NO levanta nada: lee el script del smoke, el runner y el Compose como TEXTO
// y afirma que juntos describen el escenario que hay que correr. Es la misma decisión que
// `src/deploy-smoke.test.ts` —su gemelo para PM2/Nginx— y por el mismo motivo: un smoke que nadie
// ejecuta se pudre en silencio, y el modo en que se pudre es que alguien le saque un paso para
// arreglar el CI y nadie lo note.
//
// LO QUE ESTE ARCHIVO **NO** PRUEBA: no prueba que Mongo acepte el documento. Prueba que el guion
// SIGUE ESCRITO. Quien lo prueba es `npm run test:deploy` con Docker levantado.
//
// ⚠ ACÁ NO SE ESCRIBE LA LECTURA DEL ENTORNO NI EN UN COMENTARIO, y lo aprendí al ponerlo rojo:
// `src/env-single-reader.test.ts` busca esa substring en TODO `src/` —no parsea, busca texto— para
// garantizar que el único lector es `src/env.ts`. La primera versión de este bloque explicaba la
// regla usando la literal que la regla prohíbe, y el guard la cazó. Es exactamente el
// comportamiento correcto: una excepción para un comentario es una excepción, y un guardarraíl con
// una excepción por conveniencia deja de serlo. Cuando haya que nombrarla, se arma por partes
// (`["process", "env"].join(".")`), igual que en `deploy-smoke.test.ts`.
const read = (path: string) => readFileSync(path, "utf8");

describe("la certificación del catálogo contra servicios reales", () => {
  const smoke = read("src/smoke/game-mode-smoke.ts");
  const runner = read("scripts/run-engine-smoke.mjs");
  const compose = read("compose.smoke.yaml");

  // LA FORMA PRODUCTIVA, que es lo único que no se puede medir con un doble del driver: el doble
  // acepta el documento que le demos. Mongo acepta el que Mongo acepta.
  it("mide la colección, sus cuatro índices y el `__v` de v1", () => {
    expect(smoke).toContain("game_modes_domino");
    for (const índice of ["uuid_1", "isActive_1", "isActive_1_name_1", "isActive_1_uuid_1"])
      expect(smoke).toContain(índice);
    expect(smoke).toContain("__v");
  });

  // LAS SEIS RUTAS DE v1. Si alguna deja de ejercitarse, el smoke sigue verde y la ruta puede
  // haberse caído: el panel es el único consumidor y no hay nadie más que la note.
  it("ejercita las seis rutas HTTP", () => {
    expect(smoke).toContain("/game-modes");
    expect(smoke).toContain("/game-modes/reactive/");
    for (const verbo of ["POST", "PUT", "DELETE", "GET"]) expect(smoke).toContain(verbo);
  });

  // UNA COMPARACIÓN LITERAL DEL DTO, no un `objectContaining`: lo que hay que cazar es un campo de
  // MENOS —el panel deja de verlo— o uno de MÁS, y una aserción parcial no ve el de más.
  it("compara el DTO devuelto campo por campo", () => {
    expect(smoke).toMatch(/deepStrictEqual|toEqual/);
    expect(smoke).toContain("playersQuantity");
  });

  // DOS PROCESOS PM2 SIRVIENDO EL MISMO CATÁLOGO. El catálogo vive en Mongo, así que las dos
  // instancias tienen que contestar lo mismo — y si alguien lo volviera a poner en memoria, cada
  // una contestaría lo suyo y nadie se enteraría hasta producción.
  it("consulta el catálogo por los dos puertos de PM2", () => {
    expect(smoke).toContain("2567");
    expect(smoke).toContain("2568");
  });

  // LIMPIEZA PASE LO QUE PASE. Sin esto, una fase que falla deja el stack arriba y la corrida
  // siguiente arranca contra los datos de la anterior — que es el falso verde más caro de un smoke,
  // porque se ve igual que uno sano.
  it("limpia el stack en un finally y propaga el primer código no cero", () => {
    expect(runner).toContain("finally");
    expect(runner).toContain('"down", "-v", "--remove-orphans"');
  });

  // NINGÚN `sleep` CIEGO DECIDE ÉXITO. Un plazo explícito por espera falla diciendo qué no llegó;
  // un sleep fijo pasa en una máquina rápida y se pone rojo en el CI sin explicar por qué.
  it("espera con plazos explícitos y no con sleeps que deciden", () => {
    expect(smoke).toMatch(/10_000|10000/);
    expect(smoke).toMatch(/waitUntil|esperarHasta|waitFor/);
  });

  // EL CLIENTE NECESITA `MONGO_URI` PARA ASERTAR DESDE AFUERA: mira el documento que quedó escrito
  // y no lo que el servidor DICE.
  it("le pasa al cliente la URI de Mongo para asertar por fuera de HTTP", () => {
    const cliente = compose.slice(compose.indexOf("smoke-client:"));
    expect(cliente).toContain("MONGO_URI");
    expect(compose).toContain("INTERNAL_API_KEY");
  });

  // `--no-deps` EN EL CLIENTE: el stack ya está arriba, y sin esto `compose run` levantaría una
  // segunda copia de lo que el cliente declara.
  it("corre el cliente con --no-deps", () => {
    expect(runner).toContain("--no-deps");
    expect(runner).toContain("smoke:game-mode");
  });

  it("el package.json declara el comando que el runner invoca", () => {
    const scripts = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(scripts.scripts["smoke:game-mode"]).toBe("tsx src/smoke/game-mode-smoke.ts");
  });

  // UN SOLO PASO EN CI Y NINGÚN BLOQUE `services:`. Es Compose quien levanta Mongo y Redis, así que
  // un `services:` sería una segunda infraestructura que hay que mantener sincronizada y que no
  // agrega una sola aserción.
  it("CI conserva un solo paso de deploy y ningún bloque services", () => {
    const ci = read(".github/workflows/ci.yml");
    // La CLAVE YAML, no la palabra: el archivo ARGUMENTA en un comentario por qué no la tiene, y
    // una aserción sobre la substring pelada se pondría roja por la propia explicación.
    expect(ci).not.toMatch(/^\s+services:\s*$/m);
    expect(ci.match(/npm run test:deploy/g) ?? []).toHaveLength(1);
  });
});
