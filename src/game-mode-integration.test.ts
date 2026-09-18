import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// EL CONTRATO ESTÁTICO DE LA CERTIFICACIÓN, y existe porque lo que mide está del otro lado de
// Docker. Este archivo NO levanta nada: lee el script de fases, el runner y el Compose como TEXTO y
// afirma que juntos describen el escenario que hay que correr. Es la misma decisión que
// `src/deploy-smoke.test.ts` —su gemelo para PM2/Nginx— y por el mismo motivo: un smoke que nadie
// ejecuta se pudre en silencio, y el modo en que se pudre es que alguien le saque una fase para
// arreglar el CI y nadie lo note.
//
// LO QUE ESTE ARCHIVO **NO** PRUEBA, y conviene decirlo para que nadie lo lea como si lo hiciera:
// no prueba que Mongo acepte el documento, ni que el consumidor reciba el cuerpo, ni que el
// reconciliador emita. Prueba que el guion de esas tres cosas SIGUE ESCRITO. Quien las prueba es
// `npm run test:deploy` con Docker levantado.
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
  const phases = read("src/smoke/game-mode-smoke.ts");
  const runner = read("scripts/run-engine-smoke.mjs");
  const compose = read("compose.smoke.yaml");
  const juntos = `${phases}\n${runner}\n${compose}`;

  // LA FORMA PRODUCTIVA, que es lo único que no se puede medir con un doble del driver: el doble
  // acepta el documento que le demos. Mongo acepta el que Mongo acepta.
  it("mide la colección, sus cuatro índices y el `__v` de v1", () => {
    expect(phases).toContain("game_modes_domino");
    for (const índice of ["uuid_1", "isActive_1", "isActive_1_name_1", "isActive_1_uuid_1"])
      expect(phases).toContain(índice);
    expect(phases).toContain("__v");
  });

  // LAS SIETE RUTAS DE v1. Si alguna deja de ejercitarse, el smoke sigue verde y la ruta puede
  // haberse caído: el panel es el único consumidor y no hay nadie más que la note.
  it("ejercita las siete rutas HTTP", () => {
    expect(phases).toContain("/game-modes");
    expect(phases).toContain("/game-modes/sync");
    expect(phases).toContain("/game-modes/reactive/");
    for (const verbo of ["POST", "PUT", "DELETE", "GET"]) expect(phases).toContain(verbo);
  });

  // EL CONTRATO RABBIT, que es lo que consume otro sistema. El exchange y las dos claves van
  // literales: recalcularlos importando `events.ts` mediría que dos expresiones idénticas dan lo
  // mismo, y acompañaría un rename sin ponerse rojo.
  it("mide el exchange y las dos claves de ruteo de v1", () => {
    expect(phases).toContain("betaso");
    expect(phases).toContain("game_mode.created");
    expect(phases).toContain("game_mode.updated");
  });

  // UNA COMPARACIÓN LITERAL DEL CUERPO, no un `objectContaining`: lo que hay que medir contra el
  // consumidor real es que NO viajen `isFreeRoom` ni `enableBots`, y una aserción parcial no puede
  // ver un campo de más.
  it("compara el payload publicado campo por campo", () => {
    expect(phases).toMatch(/deepStrictEqual|toEqual/);
    expect(phases).toContain("playerCount");
  });

  // EL ESCENARIO QUE JUSTIFICA EL OUTBOX ENTERO, y el único que ninguna suite puede medir: con el
  // broker apagado la mutación tiene que contestar OK igual, el evento quedar `PENDING` en Mongo, y
  // salir solo cuando Rabbit vuelve.
  it("cubre Rabbit apagado, encolado y recuperado", () => {
    for (const fase of ["normal", "enqueue", "recover"]) expect(phases).toContain(fase);
    expect(phases).toContain("PENDING");
    expect(phases).toContain("SENT");
    expect(runner).toContain("stop");
    expect(runner).toContain("rabbitmq");
  });

  // EL RECONCILIADOR, que es lo único que cubre la falta de transacción entre las dos colecciones.
  // Se prueba rompiendo a mano lo que la aplicación nunca rompe: se avanza el `__v` del documento
  // sin escribir el outbox, que es exactamente la ventana que se pierde si el proceso muere entre
  // las dos escrituras.
  it("fuerza la ventana modo→outbox y espera que el reconciliador la cierre", () => {
    expect(phases).toContain("reconcil");
  });

  // DOS PROCESOS PM2 SIRVIENDO EL MISMO CATÁLOGO. El catálogo vive en Mongo, así que las dos
  // instancias tienen que contestar lo mismo — y si alguien lo volviera a poner en memoria, cada
  // una contestaría lo suyo y nadie se enteraría hasta producción.
  it("consulta el catálogo por los dos puertos de PM2", () => {
    expect(phases).toContain("2567");
    expect(phases).toContain("2568");
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
    expect(phases).toMatch(/10_000|10000/);
    expect(phases).toMatch(/waitUntil|esperarHasta|waitFor/);
  });

  // EL COMPOSE TIENE BROKER, CON HEALTHCHECK Y VOLUMEN AISLADO. Sin healthcheck, la fase `recover`
  // arrancaría contra un Rabbit que todavía no atiende y el rojo sería un timeout que no dice nada.
  it("levanta RabbitMQ con healthcheck y se lo pasa a la app y al cliente", () => {
    expect(compose).toContain("rabbitmq:");
    expect(compose).toContain("rabbitmq-diagnostics");
    expect(compose).toContain("RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672");
    expect(compose).toContain("INTERNAL_API_KEY");
  });

  // EL CLIENTE NECESITA LAS DOS URLS PARA ASERTAR DESDE AFUERA: mira el documento en Mongo y el
  // mensaje en la cola. Un cliente que sólo hablara HTTP mediría lo que el servidor DICE, no lo que
  // quedó escrito.
  it("le pasa al cliente las URLs de Mongo y Rabbit para asertar por fuera de HTTP", () => {
    const cliente = compose.slice(compose.indexOf("smoke-client:"));
    expect(cliente).toContain("MONGO_URI");
    expect(cliente).toContain("RABBITMQ_URL");
  });

  // `--no-deps` EN TODAS LAS FASES DE CLIENTE, y es la línea que más fácil se borra sin entender:
  // sin ella `compose run` vuelve a LEVANTAR RabbitMQ al intentar certificar que está caído, y la
  // fase `enqueue` mediría exactamente lo contrario de lo que dice medir — en verde.
  it("corre las fases de cliente con --no-deps", () => {
    expect(runner).toContain("--no-deps");
    expect(runner).toContain("smoke:game-mode");
  });

  it("el package.json declara el comando que el runner invoca", () => {
    const scripts = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(scripts.scripts["smoke:game-mode"]).toBe("tsx src/smoke/game-mode-smoke.ts");
  });

  // UN SOLO PASO EN CI Y NINGÚN BLOQUE `services:`. Es Compose quien levanta Mongo, Redis y Rabbit
  // —igual que ya hace con los dos primeros—, así que un `services:` sería una segunda
  // infraestructura que hay que mantener sincronizada y que no agrega una sola aserción.
  it("CI conserva un solo paso de deploy y ningún bloque services", () => {
    const ci = read(".github/workflows/ci.yml");
    // La CLAVE YAML, no la palabra: el archivo ARGUMENTA en un comentario por qué no la tiene, y
    // una aserción sobre la substring pelada se pondría roja por la propia explicación.
    expect(ci).not.toMatch(/^\s+services:\s*$/m);
    expect(ci.match(/npm run test:deploy/g) ?? []).toHaveLength(1);
  });
});
