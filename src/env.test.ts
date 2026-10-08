import { describe, expect, it } from "vitest";
import { isDevEnvironment, isTestingEnvironment, parseEnv } from "./env";

// `parseEnv` solo exige que la clave esté; que sea una pública EC P-256 lo valida `JwtVerifier`.
const KEY = "pem-de-prueba";

describe("parseEnv", () => {
  it("acepta un entorno completo", () => {
    // Producción exige además las tres de infraestructura (ver el describe de más abajo), así
    // que el "entorno completo" de este test es el completo de verdad y no el mínimo que compila.
    const env = parseEnv({
      NODE_ENV: "production",
      PORT: "3000",
      BILLING_AUTH_PUBLIC_KEY: KEY,
      MONGO_URI: "mongodb://mongo:27017/domino",
      RABBITMQ_URL: "amqp://guest:guest@rabbitmq:5672",
      ADMIN_API_KEY: "k".repeat(16),
    });
    expect(env.port).toBe(3000);
    expect(env.nodeEnv).toBe("production");
    expect(env.billingAuth.publicKeyPem).toBe(KEY);
  });

  it("aplica los defaults de desarrollo", () => {
    const env = parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY });
    expect(env.nodeEnv).toBe("development");
    expect(env.port).toBe(2567);
    expect(env.logLevel).toBe("debug");
    expect(env.turnTimeoutMs).toBe(60_000);
    expect(env.extraTimeReserveMs).toBe(30_000);
    expect(env.dealingTimeoutMs).toBe(20_000);
    expect(env.presentingRoundMs).toBe(4_000);
    expect(env.presentingMatchMs).toBe(4_000);
    expect(env.seatingTimeoutMs).toBe(30_000);
  });

  it("permite acortar los plazos desde el entorno", () => {
    const env = parseEnv({
      BILLING_AUTH_PUBLIC_KEY: KEY,
      TURN_TIMEOUT_MS: "600",
      EXTRA_TIME_RESERVE_MS: "300",
      DEALING_TIMEOUT_MS: "800",
      PRESENTING_ROUND_MS: "120",
      PRESENTING_MATCH_MS: "130",
      SEATING_TIMEOUT_MS: "3000",
    });

    expect(env.turnTimeoutMs).toBe(600);
    expect(env.extraTimeReserveMs).toBe(300);
    expect(env.dealingTimeoutMs).toBe(800);
    expect(env.presentingRoundMs).toBe(120);
    expect(env.presentingMatchMs).toBe(130);
    expect(env.seatingTimeoutMs).toBe(3_000);
  });

  it("en producción el nivel de log baja a info", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      BILLING_AUTH_PUBLIC_KEY: KEY,
      MONGO_URI: "mongodb://mongo:27017/domino",
      RABBITMQ_URL: "amqp://guest:guest@rabbitmq:5672",
      ADMIN_API_KEY: "k".repeat(16),
    });
    expect(env.logLevel).toBe("info");
  });

  // CUÁNTO SE CUENTA LO DECIDE EL ENTORNO, no `NODE_ENV`: dev corre con `NODE_ENV=production`
  // igual que prod, así que con la regla vieja dev perdía la traza del juego, que es justo para lo
  // que existe dev. Truco `b22ce07`.
  it("dev cuenta la traza del juego aunque corra con NODE_ENV=production", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      APP_ENV: "dev",
      BILLING_AUTH_PUBLIC_KEY: KEY,
      MONGO_URI: "mongodb://mongo:27017/domino",
      RABBITMQ_URL: "amqp://guest:guest@rabbitmq:5672",
      ADMIN_API_KEY: "k".repeat(16),
    });
    expect(env.logLevel).toBe("debug");
  });

  // STAGE TAMBIÉN (truco `0c4d67f`): es un entorno de prueba, y el nivel del log no cambia cómo se
  // juega una partida, sólo cuánto se escribe. Sólo prod se queda en `info`.
  it("stage cuenta la traza del juego", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      APP_ENV: "stage",
      BILLING_AUTH_PUBLIC_KEY: KEY,
      MONGO_URI: "mongodb://mongo:27017/domino",
      RABBITMQ_URL: "amqp://guest:guest@rabbitmq:5672",
      ADMIN_API_KEY: "k".repeat(16),
    });
    expect(env.logLevel).toBe("debug");
  });

  // Y UN LOG_LEVEL EXPLÍCITO SIEMPRE GANA: es para prender `debug` en prod una hora, mirando una
  // partida, sin tocar código ni el default de nadie.
  it("un LOG_LEVEL explícito le gana al entorno", () => {
    const env = parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY, LOG_LEVEL: "warn" });
    expect(env.logLevel).toBe("warn");
  });

  it("RELEASE viaja tal cual, y sin él no hay release", () => {
    const key = { BILLING_AUTH_PUBLIC_KEY: KEY };
    expect(parseEnv({ ...key, RELEASE: "20261006-abc" }).release).toBe("20261006-abc");
    expect(parseEnv(key).release).toBeUndefined();
  });

  it("con BILLING_AUTH_PUBLIC_KEY confía en billing-auth, con emisor y audiencia por defecto", () => {
    const parsed = parseEnv({
      BILLING_AUTH_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----",
    });
    expect(parsed.billingAuth).toEqual({
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
      issuer: "betaso-auth",
      audience: "domino",
    });
  });

  // TODOS LOS JUGADORES traen el ES256 de billing-auth: sin su clave pública nadie entra a una mesa.
  it("rechaza un entorno sin BILLING_AUTH_PUBLIC_KEY", () => {
    expect(() => parseEnv({})).toThrow(/BILLING_AUTH_PUBLIC_KEY/);
  });

  it("rechaza una BILLING_AUTH_PUBLIC_KEY vacía", () => {
    expect(() => parseEnv({ BILLING_AUTH_PUBLIC_KEY: "" })).toThrow(/BILLING_AUTH_PUBLIC_KEY/);
  });

  it("rechaza un PORT que no es número", () => {
    expect(() => parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY, PORT: "abc" })).toThrow(/PORT/);
  });

  // Ausente es un estado LEGÍTIMO y significa "esta instancia no expone /internal/*".
  // Por eso no tiene default: un default es una llave publicada.
  it("sin ADMIN_API_KEY el entorno es válido y la llave queda indefinida", () => {
    expect(parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY }).adminApiKey).toBeUndefined();
  });

  it("rechaza una ADMIN_API_KEY corta en vez de aceptar una llave enumerable", () => {
    expect(() => parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY, ADMIN_API_KEY: "corta" })).toThrow(
      /ADMIN_API_KEY/,
    );
  });

  // Ausente es un estado LEGÍTIMO y significa "clúster de uno": Colyseus se queda con su driver
  // y su presence locales y el registro de partidas con el almacén de memoria. Es el mismo
  // criterio que MONGO_URI — la presencia del dato elige, sin un interruptor que la nombre.
  it("sin REDIS_URL el entorno es válido y el clúster queda en uno", () => {
    expect(parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY }).redisUrl).toBeUndefined();
  });

  // RABBITMQ_URL sigue el mismo criterio que las otras dos URIs: la PRESENCIA del dato elige la
  // implementación y no hay ningún `AMQP_DRIVER` que nombre una. Ausente significa que esta
  // instancia no publica al broker —el outbox sigue acumulando, que es el punto entero de que
  // sea durable—, y es lo que hace que `npm test` no toque la red.
  it("sin RABBITMQ_URL el entorno es válido y la URL queda indefinida", () => {
    expect(parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY }).rabbitmqUrl).toBeUndefined();
  });

  // EN PRODUCCIÓN LAS TRES SON OBLIGATORIAS, y acá está la asimetría que vale escribir: fuera
  // de producción, "ausente" es la decisión legítima de una instancia que corre sola y sin
  // infraestructura. En producción es lo contrario — un despliegue productivo sin `MONGO_URI`
  // arranca creyendo que persiste, sin `RABBITMQ_URL` acumula eventos que nadie va a publicar, y
  // sin `ADMIN_API_KEY` deja el catálogo sin su API administrativa. Todas fallan en SILENCIO, que es exactamente la clase de
  // error que un arranque tiene que rechazar.
  describe("en producción exige la infraestructura completa", () => {
    const productivo = {
      NODE_ENV: "production",
      BILLING_AUTH_PUBLIC_KEY: KEY,
      MONGO_URI: "mongodb://mongo:27017/domino",
      RABBITMQ_URL: "amqp://guest:guest@rabbitmq:5672",
      ADMIN_API_KEY: "k".repeat(16),
    };

    it("acepta el entorno productivo completo", () => {
      const env = parseEnv(productivo);
      expect(env.mongoUri).toBe("mongodb://mongo:27017/domino");
      expect(env.rabbitmqUrl).toBe("amqp://guest:guest@rabbitmq:5672");
      expect(env.adminApiKey).toBe("k".repeat(16));
    });

    it.each([["MONGO_URI"], ["RABBITMQ_URL"], ["ADMIN_API_KEY"]] as const)(
      "rechaza producción sin %s",
      (faltante) => {
        const { [faltante]: _, ...incompleto } = productivo;
        expect(() => parseEnv(incompleto)).toThrow(new RegExp(faltante));
      },
    );

    // UN SOLO ERROR QUE LAS ENUMERA, no el primero que aparece. Un arranque que dice "falta
    // MONGO_URI", se corrige, y entonces dice "falta RABBITMQ_URL" es tres despliegues en vez de
    // uno — y cada intento contra un entorno productivo cuesta una ventana de mantenimiento.
    it("nombra TODAS las que faltan en un solo error", () => {
      const intento = () => parseEnv({ NODE_ENV: "production", BILLING_AUTH_PUBLIC_KEY: KEY });
      expect(intento).toThrow(/MONGO_URI/);
      expect(intento).toThrow(/RABBITMQ_URL/);
      expect(intento).toThrow(/ADMIN_API_KEY/);
    });

    // La misma ausencia FUERA de producción no es un error: es el despliegue de desarrollo.
    it("fuera de producción las tres pueden faltar", () => {
      const env = parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY });
      expect(env.mongoUri).toBeUndefined();
      expect(env.rabbitmqUrl).toBeUndefined();
      expect(env.adminApiKey).toBeUndefined();
    });
  });

  // `PORT` ES LA BASE Y NO EL PUERTO, y no es una convención nuestra: `@colyseus/tools` le suma
  // `NODE_APP_INSTANCE` ADENTRO de `listen()` (`build/index.mjs`, `port += processNumber`, medido
  // sobre la 0.18.3 instalada). pm2 en modo fork es quien pone esa variable, así que con base
  // 2567 la instancia 1 escucha en 2568 mientras su entorno sigue diciendo 2567.
  //
  // Éste es el número que hay que ANUNCIAR y el que hay que loguear. El que se le pasa a
  // `listen()` es el otro: pasarle éste contaría el índice dos veces —con base 2567 la instancia
  // 1 ataría 2569— y el síntoma es un puerto al que no llega nadie.
  it("el puerto efectivo le suma el índice de instancia a la base", () => {
    const env = parseEnv({
      BILLING_AUTH_PUBLIC_KEY: KEY,
      PORT: "2567",
      NODE_APP_INSTANCE: "1",
    });

    expect(env.port).toBe(2567);
    expect(env.instanceIndex).toBe(1);
    expect(env.listeningPort).toBe(2568);
  });

  // `undefined` NO es la instancia 0: es que esto no lo levantó pm2, y ése es un caso distinto
  // —una sola instancia, que se anuncia SIN puerto en el path—.
  it("sin pm2 no hay índice y el puerto efectivo es la base", () => {
    const env = parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY, PORT: "2567" });

    expect(env.instanceIndex).toBeUndefined();
    expect(env.listeningPort).toBe(2567);
  });

  // EL PUERTO VA COMO PATH, que es el esquema de v1: es lo que hace que el proxy que ya rutea v1
  // rutee esto sin aprender nada nuevo. Si esto se escribiera `host:puerto`, el cliente recibiría
  // en la reserva de asiento una dirección que el proxy no sabe resolver.
  //
  // Y EL PUERTO QUE VA ES EL EFECTIVO. Anunciar la base manda al jugador al proceso equivocado, y
  // es la única falla de esta pieza que aparece en el cliente y no en el servidor: el nodo que se
  // lleva la conexión contesta con total confianza que esa sala no es suya.
  it("con pm2 anuncia el host y el puerto EFECTIVO como path", () => {
    const env = parseEnv({
      BILLING_AUTH_PUBLIC_KEY: KEY,
      SERVER_ADDRESS: "domino.betaso.com",
      PORT: "2567",
      NODE_APP_INSTANCE: "1",
    });

    expect(env.publicAddress).toBe("domino.betaso.com/2568");
  });

  // SIN pm2 SE ANUNCIA PLANO, que es lo que hace v1: un solo proceso no necesita el puerto en el
  // path, y ponérselo exigiría un proxy que rutee por prefijo para un despliegue que no lo pide.
  it("sin pm2 anuncia la dirección tal cual, sin puerto", () => {
    const env = parseEnv({
      BILLING_AUTH_PUBLIC_KEY: KEY,
      SERVER_ADDRESS: "domino.betaso.com",
      PORT: "2568",
    });

    expect(env.publicAddress).toBe("domino.betaso.com");
  });

  // Sin SERVER_ADDRESS no se anuncia NADA, y no una dirección a medias: el cliente vuelve al host
  // al que ya le habló, que es lo correcto con una instancia sola.
  it("sin SERVER_ADDRESS no anuncia ninguna dirección", () => {
    expect(parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY }).publicAddress).toBeUndefined();
  });

  it("solo activa el smoke con el valor 1", () => {
    expect(parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY, RUN_ENGINE_SMOKE: "1" }).runEngineSmoke).toBe(
      true,
    );
    expect(
      parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY, RUN_ENGINE_SMOKE: "true" }).runEngineSmoke,
    ).toBe(false);
  });

  it("rechaza un NODE_ENV fuera del enum", () => {
    expect(() => parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY, NODE_ENV: "staging" })).toThrow(
      /NODE_ENV/,
    );
  });

  it("sin ORCHESTRATOR_API_KEY no se abre la API del orquestador", () => {
    expect(parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY }).orchestratorApiKey).toBeUndefined();
  });

  it("rechaza una ORCHESTRATOR_API_KEY corta en vez de aceptar una llave enumerable", () => {
    expect(() => parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY, ORCHESTRATOR_API_KEY: "corta" })).toThrow(
      /ORCHESTRATOR_API_KEY/,
    );
  });
  describe("las llaves del orquestador", () => {
    const base = { BILLING_AUTH_PUBLIC_KEY: KEY };
    const orq = "o".repeat(16);

    const callback = {
      ORCHESTRATOR_URL: "http://127.0.0.1:2570",
      ORCHESTRATOR_CALLBACK_API_KEY: "c".repeat(16),
    };

    it("con la llave, la clave pública y a quién pedirle los cobros, arranca", () => {
      const env = parseEnv({
        ...base,
        ...callback,
        ORCHESTRATOR_API_KEY: orq,
      });
      expect(env.orchestratorApiKey).toBe(orq);
      // CON BARRA FINAL: el cliente concatena el path.
      expect(env.orchestratorCallback).toEqual({
        url: "http://127.0.0.1:2570/",
        apiKey: "c".repeat(16),
      });
    });

    // SIN A QUIÉN PEDIRLE LOS COBROS, una mesa del orquestador se abre y no puede arrancar nunca.
    it("con ORCHESTRATOR_API_KEY exige la URL y la llave de los cobros, y las nombra juntas", () => {
      expect(() => parseEnv({ ...base, ORCHESTRATOR_API_KEY: orq })).toThrow(
        /ORCHESTRATOR_URL, ORCHESTRATOR_CALLBACK_API_KEY/,
      );
    });

    it("en producción exige además el broker de los resultados", () => {
      expect(() =>
        parseEnv({
          ...base,
          ...callback,
          NODE_ENV: "production",
          MONGO_URI: "mongodb://mongo:27017/domino",
          RABBITMQ_URL: "amqp://guest:guest@rabbitmq:5672",
          ADMIN_API_KEY: "k".repeat(16),
          ORCHESTRATOR_API_KEY: orq,
        }),
      ).toThrow(/BETASO_GAMES_RABBITMQ_URL/);
    });

    it.each(["ORCHESTRATOR_API_KEY", "ADMIN_API_KEY"])(
      "rechaza una ORCHESTRATOR_CALLBACK_API_KEY igual a %s",
      (otra) => {
        const repetida = "r".repeat(16);
        expect(() =>
          parseEnv({
            ...base,
            ...callback,
            ORCHESTRATOR_API_KEY: orq,
            [otra]: repetida,
            ORCHESTRATOR_CALLBACK_API_KEY: repetida,
          }),
        ).toThrow(/ORCHESTRATOR_CALLBACK_API_KEY no puede ser igual/);
      },
    );

    it("rechaza una ORCHESTRATOR_API_KEY igual a la de administración: cada llave abre lo suyo", () => {
      expect(() =>
        parseEnv({
          ...base,
          ORCHESTRATOR_API_KEY: orq,
          ADMIN_API_KEY: orq,
        }),
      ).toThrow(/ORCHESTRATOR_API_KEY.*ADMIN_API_KEY/);
    });
  });

  // `NODE_ENV` vale `production` en dev, stage y prod por igual, así que no puede decir EN CUÁL se
  // está. `APP_ENV` sí, y lo que decide —hoy, montar las herramientas de Colyseus que muestran el
  // estado entero de cada sala— no puede quedar prendido en prod por olvido.
  describe("APP_ENV", () => {
    const productivo = {
      NODE_ENV: "production",
      BILLING_AUTH_PUBLIC_KEY: KEY,
      MONGO_URI: "mongodb://mongo:27017/domino",
      RABBITMQ_URL: "amqp://guest:guest@rabbitmq:5672",
      ADMIN_API_KEY: "k".repeat(16),
    };

    it("sin declarar, fuera de producción es local", () => {
      expect(parseEnv({ BILLING_AUTH_PUBLIC_KEY: KEY }).appEnv).toBe("local");
    });

    // FALLA CERRADO: un servidor cuyo `.env` no lo declara no puede terminar con el monitor abierto.
    it("sin declarar, en producción es prod", () => {
      expect(parseEnv(productivo).appEnv).toBe("prod");
    });

    it("declarado, gana sobre NODE_ENV", () => {
      expect(parseEnv({ ...productivo, APP_ENV: "dev" }).appEnv).toBe("dev");
    });

    it("rechaza un entorno que no existe", () => {
      expect(() => parseEnv({ ...productivo, APP_ENV: "production" })).toThrow(/APP_ENV/);
    });
  });

  it.each([
    ["local", true],
    ["dev", true],
    ["stage", false],
    ["prod", false],
  ] as const)("isDevEnvironment(%s) es %s", (appEnv, esperado) => {
    expect(isDevEnvironment(appEnv)).toBe(esperado);
  });

  // EL REPARTO Y EL MARCADOR PREPARADOS, en todos lados menos prod (truco `2d7e1b3`, `97e475a`):
  // stage es donde una mano se prueba de punta a punta antes de salir. El playground y el monitor
  // siguen siendo sólo de `isDevEnvironment` —el monitor muestra las fichas de todos—.
  it.each([
    ["local", true],
    ["dev", true],
    ["stage", true],
    ["prod", false],
  ] as const)("isTestingEnvironment(%s) es %s", (appEnv, esperado) => {
    expect(isTestingEnvironment(appEnv)).toBe(esperado);
  });
});
