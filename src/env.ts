// El ÚNICO lugar del repo que lee process.env. Todo lo demás recibe la config
// por constructor o por el container. Enforced por src/env-single-reader.test.ts.
//
// Efecto secundario a nivel de módulo: importar este archivo ejecuta `parseEnv(process.env)`
// y lanza de inmediato si el entorno es inválido (p.ej. falta JWT_SECRET) — antes de que
// corra cualquier código propio del importador. En test, vitest.setup.ts pone defaults para
// que esto nunca truene solo por faltar configuración de entorno.
import { z } from "zod";

/**
 * EL `.env`, CARGADO POR SU CONSUMIDOR. Lo carga este archivo —el único lector de la
 * configuración del proceso— y no el de pm2. Truco venía del revés heredado de v1: su
 * `ecosystem.config.js` llamaba a dotenv y el proceso hijo heredaba ese `process.env` de
 * rebote, con lo que la configuración de la aplicación terminaba dependiendo de QUIÉN la
 * arrancó. En node 22 leer el propio no cuesta ninguna dependencia: `process.loadEnvFile()`.
 *
 * NO ES REDUNDANTE CON `@colyseus/tools`, que también carga un `.env` al importarse
 * (`node_modules/@colyseus/tools/build/loadenv.mjs`, con dotenv). Ése solo corre si alguien
 * importa ese paquete, y hay un consumidor del entorno que NO lo importa: `src/replay.ts`, la
 * herramienta de soporte. Medido sobre el grafo de imports: `npm run replay` con un `.env` que
 * tiene `MONGO_URI` no veía la URI y contestaba "no hay historial para esa partida" — el 404
 * que más se investiga al pedo, del lado de la línea de comandos.
 *
 * TRES DECISIONES, y ninguna es preferencia:
 *
 *   · EL ARCHIVO ES OPCIONAL. En producción puede venir todo del entorno del proceso (el
 *     `environment:` del compose, el CI, el shell), así que el `ENOENT` de un `.env` que no
 *     existe NO es un error: se traga y el parseo de abajo dirá lo que falte, que es quien
 *     sabe decirlo todo junto.
 *   · EL ENTORNO LE GANA AL ARCHIVO. Es lo que mantiene mandando al `environment:` del compose
 *     —donde vive el `MONGO_URI=mongodb://mongo:27017/domino` que apunta al servicio y no a
 *     localhost— y a las variables del CI. Es el comportamiento de `loadEnvFile`, MEDIDO sobre
 *     la node 22.17.1 instalada y no leído de la documentación:
 *     `printf 'FOO=del-archivo\nBAR=solo-archivo\n' > .env && FOO=del-entorno node -e
 *     "process.loadEnvFile(); console.log(process.env.FOO, process.env.BAR)"` imprime
 *     `del-entorno solo-archivo`.
 *   · LA SUITE QUEDA AFUERA, y acá el riesgo es concreto y ya estaba vivo. `vitest.setup.ts`
 *     BORRA `MONGO_URI` y `REDIS_URL` para que `npm test` no dependa de ningún servicio
 *     externo; un `.env` cargado después de ese borrado anula el guardarraíl entero. Medido:
 *     con esas dos variables en un `.env` local, la suite pasa de 311 verdes a **18 tests
 *     rojos en 6 archivos**, porque las salas de test se van contra un Redis y un Mongo de
 *     verdad. Ver el comentario gemelo en `vitest.setup.ts`, que desactiva al OTRO cargador.
 *
 * Se expone la función —y no un `if` suelto— porque es lo que hace testeable la decisión sin
 * tocar el entorno real del worker: `src/env-dotenv.test.ts` le pasa un entorno de mentira y
 * un doble de `load`.
 */
export function loadEnvFileUnlessTest(
  source: Record<string, string | undefined>,
  load: () => void,
): void {
  if (source.VITEST) return;
  try {
    load();
  } catch {
    // No hay `.env`: el entorno ya está puesto, o falta algo y el parseo de abajo lo va a decir.
  }
}

loadEnvFileUnlessTest(process.env, () => {
  process.loadEnvFile();
});

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * El puerto BASE, que con varias instancias no es el puerto de ninguna salvo la primera.
   *
   * QUIEN SUMA NO SOMOS NOSOTROS NI pm2: es `@colyseus/tools`, adentro de su `listen()`
   * (`node_modules/@colyseus/tools/build/index.mjs`: `port += Number(process.env.NODE_APP_INSTANCE
   * || "0")`, medido sobre la 0.18.3 instalada). pm2 en modo fork solo aporta la variable.
   *
   * Por eso a `listen()` se le pasa ÉSTE y no `listeningPort`: sumarle el índice antes lo contaría
   * dos veces —con base 2567 la instancia 1 ataría 2569— y el síntoma es un puerto al que no llega
   * nadie.
   */
  PORT: z.coerce.number().int().positive().default(2567),
  /**
   * QUÉ INSTANCIA ES ÉSTA, según pm2 en modo fork. No la ponemos nosotros ni se configura: la
   * exporta pm2 al arrancar cada proceso.
   *
   * AUSENTE NO ES LA INSTANCIA 0: es que esto NO lo levantó pm2, y ése es un caso distinto —un
   * solo proceso, que se anuncia SIN puerto en el path (ver `publicAddress`)—. Por eso el campo
   * derivado es `number | undefined` y no un `0` por default.
   *
   * Se lee por acá, y no con un `process.env` suelto en `main.ts`, porque `src/env.ts` es el
   * único lector permitido de la configuración del proceso (`src/env-single-reader.test.ts`) — y
   * de paso es lo que hace que los dos casos se puedan testear sin tocar el entorno real.
   */
  NODE_APP_INSTANCE: z.coerce.number().int().nonnegative().optional(),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  EXTRA_TIME_RESERVE_MS: z.coerce.number().int().positive().default(30_000),
  DEALING_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PRESENTING_ROUND_MS: z.coerce.number().int().positive().default(6_000),
  PRESENTING_MATCH_MS: z.coerce.number().int().positive().default(6_000),
  SEATING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Cuánto se le guarda el asiento al que se cayó (`allowReconnection`). Va en SEGUNDOS
   * porque esa es la unidad de la API de Colyseus, y convertir acá sería dejar dos números
   * distintos para el mismo plazo.
   *
   * Sale del entorno por la misma razón que las duraciones de fase: el camino de la
   * ventana VENCIDA no se puede testear esperando dos minutos.
   */
  RECONNECTION_WINDOW_SECONDS: z.coerce.number().int().positive().default(120),
  // Compartido con el backend principal. El dominó verifica y NUNCA firma.
  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
  /**
   * La llave de la API INTERNA (consola de soporte). OPCIONAL y sin default a propósito:
   * un default es una llave publicada, y una llave publicada no protege nada.
   *
   * Ausente significa "esta instancia no expone `/internal/*`", y las rutas directamente
   * NO se registran (ver register-http.ts). Es fail closed: una ruta interna viva con la
   * llave vacía es PEOR que no tenerla, porque parece protegida.
   *
   * El mínimo de largo es el mismo criterio que el de JWT_SECRET: una llave corta se
   * enumera, y acá el entorno es o la llave buena o ninguna.
   */
  INTERNAL_API_KEY: z
    .string()
    .min(16, "INTERNAL_API_KEY debe tener al menos 16 caracteres")
    .optional(),
  /**
   * La URI de Mongo, donde queda escrito el historial de cada partida
   * (`mongodb://host:puerto/nombre` — la base viaja en la URI, como en truco y como en v1,
   * para que apuntar a otra sea cambiar UN valor).
   *
   * OPCIONAL, y SU PRESENCIA ES LA QUE ELIGE LA IMPLEMENTACIÓN: sin ella el historial es el
   * de memoria y muere con el proceso; con ella es el de Mongo y sobrevive al reinicio. Es
   * el mismo criterio que `INTERNAL_API_KEY` —la variable ausente es una decisión, no un
   * error— y es deliberadamente lo contrario a un `HISTORY_DRIVER`: un interruptor que
   * NOMBRA la implementación es deuda, no configuración, porque deja escribir "mongo" sin
   * URI y "memory" con una base andando al lado. Acá el dato y la decisión son lo mismo,
   * así que no existe la combinación incoherente.
   *
   * NO tiene default, ni siquiera `mongodb://localhost:27017/domino`: un default haría que
   * una instancia mal configurada arranque creyendo que persiste y escriba en una base
   * equivocada —o en ninguna—, que es peor que no persistir a la vista.
   */
  MONGO_URI: z.string().min(1).optional(),
  /**
   * La URL de Redis (`redis://host:puerto/db`), que es lo que convierte a varios procesos en UN
   * clúster. Del otro lado viven tres cosas: el registro de salas de Colyseus (para que
   * `joinById` encuentre una sala de otro nodo), el presence (para que cada proceso sepa de los
   * otros) y el registro de partidas vivas del dominó (para que `GET /config/:roomId` conteste
   * por una sala que abrió otra instancia).
   *
   * OPCIONAL, Y SU PRESENCIA ES LA QUE ELIGE, igual que `MONGO_URI` y por la misma razón: sin
   * ella Colyseus usa su driver y su presence LOCALES —`@colyseus/core/build/utils/Env.mjs`, los
   * defaults de `matchMaker.setup()`— y el registro de partidas usa el almacén de memoria, que
   * es exactamente lo correcto con UNA instancia. Con ella, los tres pasan a ser compartidos. No
   * hay ningún `CLUSTER_DRIVER` ni lo va a haber: un interruptor que nombra la implementación
   * deja escribir "redis" sin URL, y `src/di-container.test.ts` se pone rojo si aparece.
   *
   * LA BASE VIAJA EN LA URL (el `/1` del final) Y AHÍ ESTÁ EL AISLAMIENTO entre dos productos
   * que comparten un servidor de Redis — el operador que corre el truco al lado. Eso no se
   * deduce, SE MIDIÓ, porque truco pagó la versión equivocada de esta decisión (`48ac4bc`: su
   * prefijo default era el de v1 y los dos motores compartían el registro de salas).
   *
   *   · LOS DOS CLIENTES RESPETAN EL ÍNDICE. `RedisPresence` y `RedisDriver` le entregan la URL
   *     entera a ioredis —`@colyseus/redis-presence/build/index.mjs:29` y
   *     `@colyseus/redis-driver/build/RedisDriver.mjs:15`, los dos `new Redis(options)`— y
   *     ioredis hace el `SELECT` al conectar. O sea que TODA clave de los dos cae en el índice,
   *     incluidas las que escribe Colyseus y que nosotros no elegimos.
   *   · MEDIDO con dos instancias contra el mismo Redis del compose, una en `/0` y otra en `/1`:
   *     `redis-cli -n 0 KEYS '*'` y `-n 1 KEYS '*'` devuelven cada una su propio juego completo
   *     —`roomcaches`, `roomcount`, `ch:domino`, `match_config:<roomId>`,
   *     `player_match:["<platformId>","<userUuid>"]`—
   *     con los MISMOS NOMBRES en las dos. En un solo índice serían la misma clave. Y no se ven:
   *     `GET /config/<sala ajena>` da 404 y `joinById` cruzado da 522, mientras que una tercera
   *     instancia en `/0` contesta 200 por la sala de la primera y se une. El índice es lo único
   *     que cambia entre las dos mediciones.
   *
   * POR ESO NO SE PORTA EL `REDIS_KEY_PREFIX` de truco, y la razón ya no es "allá lo necesita su
   * suite": el índice cubre TODO lo que cubriría un prefijo y además sin un segundo lugar que
   * mantener sincronizado.
   *
   * LO QUE EL ÍNDICE NO CUBRE —y un prefijo TAMPOCO, que es lo que hace que no sea un argumento
   * para portarlo—: PUB/SUB EN REDIS NO TIENE BASE. Medido las dos cosas: `PUBSUB CHANNELS '*'`
   * desde una conexión en `/3` lista los canales de las instancias de `/0` y `/1`; y con un
   * `keyPrefix` de ioredis la CLAVE sale prefijada y el CANAL no (`truco-v2:clave` contra
   * `p:canal`, porque para ioredis un canal no es una clave). Lo que viaja por ahí es el IPC de
   * Colyseus, y se salva por los NOMBRES: `p:<processId>` e `ipc:<requestId>` llevan ids
   * aleatorios. Los únicos canales de nombre fijo son `$lobby`
   * (`@colyseus/core/build/matchmaker/Lobby.mjs:3`) y `concurrent:<nombre de sala>:<clave>`
   * (`MatchMaker.mjs:106`) — el lobby del dominó es una Room normal y no suscribe `$lobby`; la
   * sala de juego se llama `domino`: si algún día
   * convive con otro Colyseus que tenga una sala con ESE nombre, ahí sí hay que mirar.
   *
   * EL ÍNDICE DOCUMENTADO ES EL `/1` Y NO EL `/0` A PROPÓSITO: el `0` es donde cae todo el que no
   * eligió, y truco no elige —arma sus clientes con `{host, port, password, keyPrefix}` y sin
   * `db` (`truco-backend-v2/src/di-container.ts:102` y `:113`)—, así que sus conexiones están en
   * el `0`. Hoy no chocaríamos porque sus claves van prefijadas, pero eso es una propiedad de la
   * configuración DEL VECINO: nuestras `roomcaches` y `roomcount` van sin prefijo, y cualquier
   * Colyseus sin prefijo en el `0` es la colisión que truco ya pagó, con otro nombre.
   *
   * NO tiene default, ni siquiera `redis://127.0.0.1:6379/1`: un default haría que una instancia
   * mal configurada arranque creyendo que forma parte de un clúster.
   */
  REDIS_URL: z.string().min(1).optional(),
  /**
   * LA URL DEL BROKER (`amqp://usuario:clave@host:puerto`), por donde salen los eventos del
   * catálogo de modos (`game_mode.created` / `game_mode.updated`) hacia el exchange `betaso`.
   *
   * OPCIONAL, Y SU PRESENCIA ES LA QUE ELIGE, igual que `MONGO_URI` y `REDIS_URL`: sin ella no se
   * construye ningún publicador y el despachador del outbox no arranca. Eso NO pierde eventos —el
   * outbox es durable y sigue acumulando—, que es exactamente el punto de que la entrega esté
   * desacoplada del request administrativo. No hay ningún `AMQP_DRIVER` ni lo va a haber, por la
   * misma razón que no hay `HISTORY_DRIVER`: un interruptor que NOMBRA la implementación deja
   * escribir "rabbit" sin URL.
   *
   * NO tiene default: un default haría que una instancia mal configurada arranque creyendo que
   * publica, contra un broker que no es el suyo o que no existe.
   */
  RABBITMQ_URL: z.string().min(1).optional(),
  /**
   * LA BASE DEL BACKEND PRINCIPAL (`https://.../api/`), por donde sale el ÚNICO reporte saliente
   * que no va por cola: el resultado de la partida hacia la liga (`POST leagues/save`).
   *
   * OPCIONAL Y SU PRESENCIA ELIGE, igual que las tres de arriba: sin ella no se construye el
   * destino de liga y el cierre de la partida lo anota en vez de reportarlo. Un default sería peor
   * que no tenerla — una instancia mal configurada mandándole resultados de partidas reales al
   * backend de otro ambiente.
   *
   * ⚠ La ruta del otro lado va SIN credencial, tal como está en v1. No es una decisión de este
   * repo y está anotada donde se usa (`network/transports/http-leagues.ts`).
   */
  BACKEND_URL: z.string().url().optional(),
  /**
   * CÓMO SE LLEGA A ESTE PROCESO DESDE AFUERA, sin el puerto. Colyseus se lo manda al cliente en
   * la reserva de asiento, y por eso cada instancia anuncia la SUYA: con las salas repartidas, el
   * jugador tiene que conectarse al proceso que hospeda la suya, no a cualquiera.
   *
   * TRES CASOS Y NO DOS, que es lo que hace v1 y lo que cuesta una línea entender:
   *
   *   · SIN esta variable no se anuncia nada y el cliente sigue hablándole a donde ya llegó. Es lo
   *     correcto con una instancia sola.
   *   · CON esta variable y SIN pm2 se anuncia TAL CUAL: hay un solo proceso y no hay a quién
   *     distinguir, así que meterle un puerto en el path exigiría un proxy que no hace falta.
   *   · CON pm2 se anuncia `host/{puerto EFECTIVO}` —el esquema de v1—, y eso SÍ da por supuesto
   *     un proxy que rutea por prefijo de path. Es la advertencia a confirmar con infraestructura
   *     antes de subir a dos instancias: si el proxy no lo hace, el que no llega es el cliente y
   *     el servidor no se entera.
   *
   * EL PUERTO QUE VA ES EL EFECTIVO Y NO `PORT` (ver `listeningPort`). Anunciar la base manda al
   * jugador al proceso equivocado, y es la única falla de esta pieza que aparece en el cliente y
   * no en el servidor: el nodo que se lleva la conexión contesta con total confianza que esa sala
   * no es suya.
   */
  SERVER_ADDRESS: z.string().min(1).optional(),
  /**
   * Interruptor de HERRAMIENTA, no de producto: regenera los fixtures golden del replay
   * (`writeGolden` en features/match/tests/e2e-harness.ts). El servidor nunca lo mira.
   * Vive acá igual porque este archivo es el único lector de la configuración del proceso
   * —invariante con test propio en env-single-reader.test.ts—, y un guardarraíl con una
   * excepción por conveniencia deja de ser un guardarraíl.
   * Cualquier valor distinto de "1" lo deja apagado, así que no hay entorno que rechazar.
   */
  WRITE_GOLDEN: z.string().optional(),
  /** Activa exclusivamente el cliente de certificación Docker/PM2/Nginx. */
  RUN_ENGINE_SMOKE: z.string().optional(),
});

export interface Env {
  readonly nodeEnv: z.infer<typeof schema>["NODE_ENV"];
  /** El puerto BASE, el que se le pasa a `listen()`. NO es el que esta instancia ata. Ver PORT. */
  readonly port: number;
  /** `undefined` ⇒ esto no lo levantó pm2. NO es la instancia 0. Ver NODE_APP_INSTANCE. */
  readonly instanceIndex: number | undefined;
  /**
   * EL PUERTO QUE ESTA INSTANCIA ATA DE VERDAD: `PORT + instanceIndex`, porque `@colyseus/tools`
   * le suma el índice adentro de `listen()`. Es el número que hay que ANUNCIAR y el que hay que
   * loguear; el que se le PASA a `listen()` es `port`.
   */
  readonly listeningPort: number;
  readonly jwtSecret: string;
  /** `undefined` ⇒ esta instancia no expone la API interna. Ver INTERNAL_API_KEY. */
  readonly internalApiKey: string | undefined;
  /** `undefined` ⇒ el historial es el de memoria y muere con el proceso. Ver MONGO_URI. */
  readonly mongoUri: string | undefined;
  /** `undefined` ⇒ este proceso es un clúster de uno: driver, presence y registro locales. */
  readonly redisUrl: string | undefined;
  /** `undefined` ⇒ esta instancia no publica: el outbox acumula. Ver RABBITMQ_URL. */
  readonly rabbitmqUrl: string | undefined;
  readonly backendUrl: string | undefined;
  /** `undefined` ⇒ este proceso no anuncia dirección. Ver SERVER_ADDRESS. */
  readonly publicAddress: string | undefined;
  readonly turnTimeoutMs: number;
  readonly extraTimeReserveMs: number;
  readonly dealingTimeoutMs: number;
  readonly presentingRoundMs: number;
  readonly presentingMatchMs: number;
  readonly seatingTimeoutMs: number;
  readonly reconnectionWindowSeconds: number;
  readonly logLevel: "debug" | "info";
  readonly writeGolden: boolean;
  readonly runEngineSmoke: boolean;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Entorno inválido — ${detail}`);
  }
  const parsed = result.data;
  // EN PRODUCCIÓN LAS CUATRO SON OBLIGATORIAS, y la asimetría con el schema es la decisión: para
  // zod siguen siendo opcionales porque FUERA de producción "ausente" es una elección legítima —una
  // instancia sola, sin infraestructura, que es el despliegue de desarrollo y el de la suite—.
  // Adentro de producción las cuatro ausencias fallan en SILENCIO, que es lo que las hace caras:
  // sin `MONGO_URI` el proceso arranca creyendo que persiste y el catálogo entero muere con él;
  // sin `RABBITMQ_URL` el outbox acumula eventos que nadie va a publicar nunca, y el consumidor
  // se queda con un catálogo viejo sin que falle nada de los dos lados; sin `INTERNAL_API_KEY`
  // las mutaciones no se registran y el panel recibe 404 donde espera administrar.
  //
  // UN SOLO ERROR QUE LAS ENUMERA, no el primero que aparece: corregir de a una es un despliegue
  // productivo por variable, y cada intento cuesta una ventana. Es el mismo criterio con el que
  // zod junta sus `issues` unas líneas más arriba.
  if (parsed.NODE_ENV === "production") {
    const faltan = (
      [
        ["MONGO_URI", parsed.MONGO_URI],
        ["RABBITMQ_URL", parsed.RABBITMQ_URL],
        ["INTERNAL_API_KEY", parsed.INTERNAL_API_KEY],
        // Sin `BACKEND_URL` la LIGA no recibe ninguna partida —ni las pagas ni las gratis— y el
        // jugador ve su tabla congelada sin que nada falle de los dos lados. Es la cuarta
        // ausencia silenciosa, y entra acá por el mismo argumento que las otras tres.
        ["BACKEND_URL", parsed.BACKEND_URL],
      ] as const
    )
      .filter(([, valor]) => valor === undefined)
      .map(([nombre]) => nombre);
    if (faltan.length > 0)
      throw new Error(`Entorno inválido — en producción faltan: ${faltan.join(", ")}`);
  }
  const instanceIndex = parsed.NODE_APP_INSTANCE;
  const listeningPort = parsed.PORT + (instanceIndex ?? 0);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    instanceIndex,
    listeningPort,
    jwtSecret: parsed.JWT_SECRET,
    internalApiKey: parsed.INTERNAL_API_KEY,
    mongoUri: parsed.MONGO_URI,
    redisUrl: parsed.REDIS_URL,
    rabbitmqUrl: parsed.RABBITMQ_URL,
    backendUrl: parsed.BACKEND_URL,
    // TRES CASOS (ver SERVER_ADDRESS). El puerto va COMO PATH y no como `host:puerto` —es el
    // esquema de v1, lo que hace que el proxy que ya rutea v1 rutee esto sin aprender nada— y es
    // el EFECTIVO, no la base. Se arma acá —el único lector del entorno— y no en el composition
    // root, para que el formato tenga UN dueño.
    publicAddress: !parsed.SERVER_ADDRESS
      ? undefined
      : instanceIndex === undefined
        ? parsed.SERVER_ADDRESS
        : `${parsed.SERVER_ADDRESS}/${listeningPort}`,
    turnTimeoutMs: parsed.TURN_TIMEOUT_MS,
    extraTimeReserveMs: parsed.EXTRA_TIME_RESERVE_MS,
    dealingTimeoutMs: parsed.DEALING_TIMEOUT_MS,
    presentingRoundMs: parsed.PRESENTING_ROUND_MS,
    presentingMatchMs: parsed.PRESENTING_MATCH_MS,
    seatingTimeoutMs: parsed.SEATING_TIMEOUT_MS,
    reconnectionWindowSeconds: parsed.RECONNECTION_WINDOW_SECONDS,
    logLevel: parsed.NODE_ENV === "production" ? "info" : "debug",
    writeGolden: parsed.WRITE_GOLDEN === "1",
    runEngineSmoke: parsed.RUN_ENGINE_SMOKE === "1",
  };
}

export const env: Env = parseEnv(process.env);
