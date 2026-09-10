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
        // mongoose/mongodb/pg/amqplib/axios/ioredis todavía no están instalados: son
        // dependencias de runtime anticipadas (DB/cola/HTTP) que este core tampoco debe usar
        // el día que se agreguen.
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
