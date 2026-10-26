import { describe, expect, it } from "vitest";
import {
  type ConnectionBlame,
  type ConnectionCause,
  type DropEvidence,
  connectionVerdictOf,
  isHighRtt,
} from "../connection";

// LA TABLA ES EL ORDEN. Cada fila cambia una cosa sobre una caída de red limpia, y las de NUESTRA van
// primero porque es la anti-meta: el panel no puede culpar al jugador de lo que fue del servidor.
const base: DropEvidence = {
  closeCode: 1006,
  replacedBySession: false,
  recentRttMs: [80, 90, 85],
  jitterMs: 5,
  server: { eventLoopP99Ms: 20, othersWithHighRtt: 0, othersConnected: 1, shuttingDown: false },
};
const server = (over: Partial<DropEvidence["server"]>) => ({ server: { ...base.server, ...over } });

const cases: [string, Partial<DropEvidence>, ConnectionBlame, ConnectionCause][] = [
  ["apagado aunque el código sea 1006", server({ shuttingDown: true }), "OURS", "SERVER_SHUTDOWN"],
  ["4001", { closeCode: 4001 }, "OURS", "SERVER_SHUTDOWN"],
  ["event loop trabado", server({ eventLoopP99Ms: 500 }), "OURS", "SERVER_OVERLOAD"],
  [
    "a todos se les fue el ping",
    server({ othersWithHighRtt: 1, othersConnected: 1 }),
    "OURS",
    "SERVER_OVERLOAD",
  ],
  [
    "nadie más conectado no es sobrecarga",
    server({ othersWithHighRtt: 0, othersConnected: 0 }),
    "NETWORK",
    "CONNECTION_LOST",
  ],
  ["4002", { closeCode: 4002 }, "OURS", "SERVER_ERROR"],
  ["salió con el botón", { closeCode: 4000 }, "INTENTIONAL", "LEFT_THE_TABLE"],
  ["cerró o recargó", { closeCode: 1001 }, "INTENTIONAL", "CLOSED_APP"],
  ["cierre normal", { closeCode: 1000 }, "INTENTIONAL", "CLOSED_APP"],
  ["el navegador avisó offline", { closeCode: 4010 }, "NETWORK", "WENT_OFFLINE"],
  [
    "4010 en apagado",
    { closeCode: 4010, ...server({ shuttingDown: true }) },
    "OURS",
    "SERVER_SHUTDOWN",
  ],
  ["corte de golpe", {}, "NETWORK", "CONNECTION_LOST"],
  ["1005", { closeCode: 1005 }, "NETWORK", "CONNECTION_LOST"],
  ["ping alto antes", { recentRttMs: [400, 350, 500] }, "NETWORK", "POOR_CONNECTION"],
  ["fluctuación", { jitterMs: 100 }, "NETWORK", "POOR_CONNECTION"],
  ["tres perdidos", { recentRttMs: [80, null, null, null, 90] }, "NETWORK", "POOR_CONNECTION"],
  [
    "desplazado sin código",
    { closeCode: null, replacedBySession: true },
    "NETWORK",
    "CONNECTION_LOST",
  ],
  ["sin muestras", { recentRttMs: [] }, "NETWORK", "CONNECTION_LOST"],
  ["código desconocido", { closeCode: 4500 }, "UNKNOWN", "UNKNOWN_CLOSE"],
  ["sin código y sin desplazar", { closeCode: null }, "UNKNOWN", "UNKNOWN_CLOSE"],
];

describe("el veredicto de una caída", () => {
  it.each(cases)("%s", (_name, over, blame, cause) => {
    expect(connectionVerdictOf({ ...base, ...over })).toEqual({ blame, cause, verdictVersion: 1 });
  });
});

describe("el ping alto", () => {
  it("sin muestras no es alto", () => {
    expect(isHighRtt([])).toBe(false);
  });

  it("se mide por la mediana, y los perdidos no cuentan", () => {
    expect(isHighRtt([100, 300, 900])).toBe(true);
    expect(isHighRtt([100, null, 200, null])).toBe(false);
  });
});
