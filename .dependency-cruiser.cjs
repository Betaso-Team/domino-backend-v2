// .dependency-cruiser.cjs
// Las cuatro reglas del spec §3.2. Cada una tiene su test en src/architecture.test.ts.
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
        dependencyTypes: ["npm"],
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
      to: { dependencyTypes: ["npm"], path: "^node_modules/tsyringe/" },
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
