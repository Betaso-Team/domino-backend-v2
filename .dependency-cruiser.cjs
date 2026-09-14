// .dependency-cruiser.cjs
// Las cuatro reglas de imports del spec §3.2 (core-allowlist, core-no-runtime,
// tsyringe-only-in-roots, feature-boundary) más no-circular, que no es una regla de imports
// sino un invariante estructural del grafo (spec §3.5). Cada una tiene su test en
// src/architecture.test.ts.
module.exports = {
  forbidden: [
    {
      name: "core-allowlist",
      comment:
        "Regla 1: features/X/core solo importa de features/X/core y de shared. Es allowlist, " +
        "no denylist: por eso el exterior puede nombrarse libremente.",
      severity: "error",
      from: { path: "^src/features/([^/]+)/core/" },
      to: {
        dependencyTypes: ["local"],
        pathNot: ["^src/features/$1/core/", "^src/shared/"],
      },
    },
    {
      name: "core-no-runtime",
      comment:
        "Regla 2: el core no importa paquetes de runtime. Excepción única y documentada: " +
        "@colyseus/schema, porque el estado ES el Schema (spec §3.4).",
      severity: "error",
      from: { path: "^src/features/[^/]+/core/" },
      to: {
        // "npm" cubre dependencies; "npm-dev" cubre devDependencies (p.ej. @colyseus/testing,
        // @colyseus/sdk). Sin "npm-dev" un import de un paquete de test/dev en el core pasa
        // desapercibido: la regla estaría verde sin proteger nada.
        dependencyTypes: ["npm", "npm-dev"],
        // OJO: depcruise matchea "to.path" contra la ruta RESUELTA (p.ej.
        // "node_modules/colyseus/build/index.cjs"), no contra el specifier del import. Por
        // eso el prefijo "^node_modules/" es obligatorio: sin él, "^colyseus" nunca matchea
        // nada y la regla queda deshabilitada en silencio (build verde, cero protección).
        // `mongodb` YA ESTÁ INSTALADO (la persistencia del historial), así que para él esta
        // regla no es anticipación sino una arista viva: el core no lo importa, y el
        // adaptador que sí lo hace vive en `shared/mongo.ts`, que es de donde el core tiene
        // permitido importar. Verificado con una violación a propósito, no de memoria.
        // mongoose/pg/amqplib/axios/ioredis siguen sin instalarse: son dependencias de
        // runtime anticipadas (DB/cola/HTTP) que este core tampoco debe usar el día que
        // lleguen.
        path: "^node_modules/(colyseus|@colyseus/(?!schema)|mongoose|mongodb|pg|amqplib|axios|ioredis|tsyringe|express)",
      },
    },
    {
      name: "tsyringe-only-in-roots",
      comment: "Regla 3: registrar y resolver son operaciones de composición.",
      severity: "error",
      from: {
        pathNot: [
          "^src/di-container\\.ts$",
          "^src/features/match/transports/colyseus/domino-room\\.ts$",
          "^src/features/match/transports/colyseus/commands/di-wiring\\.ts$",
        ],
      },
      to: {
        // Mismo motivo que en core-no-runtime: "npm-dev" cierra el hueco de devDependencies.
        dependencyTypes: ["npm", "npm-dev"],
        // Ídem: matchea contra la ruta resuelta ("node_modules/tsyringe/..."), no contra el
        // specifier "tsyringe". No quitar el prefijo "^node_modules/".
        path: "^node_modules/tsyringe/",
      },
    },
    {
      name: "di-container-only-in-roots",
      // LA OTRA MITAD DE LA REGLA 3, y la que de verdad muerde. `tsyringe-only-in-roots`
      // prohíbe la arista hacia el PAQUETE, pero nadie llega a tsyringe por el paquete:
      // se llega importando `rootContainer` de src/di-container.ts, que es un import LOCAL.
      // Depcruise evalúa ARISTAS, no alcanzabilidad transitiva, así que esa regla nunca
      // miraba el camino real y el test de arquitectura daba verde sobre una violación
      // viva (transports/http/register-http.ts resolvía cuatro dependencias del root).
      // Un archivo que importa el container SABE que el container existe, que es
      // exactamente lo que la Regla 3 prohíbe — da igual por qué puerta entró.
      comment: "Regla 3: nadie fuera de un composition root nombra el container.",
      severity: "error",
      from: {
        pathNot: [
          // El container no puede violarse a sí mismo.
          "^src/di-container\\.ts$",
          // Colyseus instancia las salas él mismo, así que una sala o no necesita
          // dependencias o es composition root. Ídem su cableado de comandos.
          "^src/features/match/transports/colyseus/domino-room\\.ts$",
          "^src/features/match/transports/colyseus/commands/di-wiring\\.ts$",
          // ENTRYPOINT: el CLI de replay arma el proceso entero, y componer es su trabajo
          // —el mismo criterio con el que truco deja src/index.ts fuera de la lista—.
          "^src/replay\\.ts$",
          // EL COMPOSITION ROOT de la superficie Express y de Colyseus: arma las dos
          // configuraciones (la real y la de test) y le pasa al transporte HTTP sus
          // dependencias ya resueltas. Es el `src/index.ts` de truco con otro nombre.
          "^src/app\\.config\\.ts$",
          // LOS TESTS QUEDAN AFUERA, y es una decisión, no un olvido. La Regla 3 existe
          // para que el código que se DESPLIEGA reciba sus dependencias sin saber quién las
          // armó; un test no tiene llamador del que recibirlas, y los que resuelven del root
          // (e2e-harness, reconnection-e2e, domino-room.test) lo hacen para AFIRMAR sobre el
          // cableado de producción: el container es el sujeto de la medición, no un
          // acoplamiento accidental. La alternativa era nombrar esos tres archivos acá, y
          // una allowlist que crece con cada e2e nuevo es una allowlist que nadie lee.
          "\\.test\\.ts$",
          "/tests/",
        ],
      },
      to: {
        // "local": el import es de un archivo del repo, no de node_modules. La ruta es la
        // RESUELTA (src/di-container.ts), no el specifier ("../../../../di-container.js").
        dependencyTypes: ["local"],
        path: "^src/di-container\\.ts$",
      },
    },
    {
      name: "feature-boundary",
      comment: "Regla 4: una feature solo importa de otra vía su index.ts.",
      severity: "error",
      from: { path: "^src/features/([^/]+)/" },
      to: { path: "^src/features/(?!$1/)[^/]+/.+", pathNot: "^src/features/[^/]+/index\\.ts$" },
    },
    {
      name: "no-circular",
      comment: "El grafo de actores es un DAG acíclico solo hacia abajo (spec §3.5).",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: [".ts", ".js"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
