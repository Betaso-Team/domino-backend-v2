import { type ApiKey, betasoBackendAuthHeaders } from "@/features/auth";
import type { HttpClient } from "@/shared/http";
import type { BetLevel } from "../../core/config";
import type { BetLevelBook } from "../bet-levels";

// EL CATÁLOGO DE NIVELES, leído del backend principal, que es donde vive. Con la llave del
// SERVIDOR: la pregunta es del dominó y no de un jugador.
//
// Ruta y parámetros son los de v1 (`bet-increase.service.ts`): el `game=domino` está porque el
// mismo endpoint sirve al truco, y el `gameModeId` porque los niveles son por mesa — el panel
// puede ofrecer x2 en la barata y x2/x5 en la cara.
//
// **NO ATRAPA NADA, y ése es el punto.** Un fallo de red tiene que SALIR de acá para que la capa
// de cache decida qué hacer: asumir que no hay niveles. Si esto devolviera `[]` ante un error, el
// que pueda tirar ese endpoint apagaría la feature sin que nadie lo vea.

const PATH = "internal/bet-increase/config";

interface RawLevel {
  readonly level?: unknown;
  readonly extra?: unknown;
  readonly additionalPoints?: unknown;
}

export class HttpBetLevelBook implements BetLevelBook {
  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: ApiKey,
  ) {}

  async levelsOf(gameModeId: string): Promise<readonly BetLevel[]> {
    const response = await this.http.get<{ levels?: unknown }>(
      `${PATH}?game=domino&gameModeId=${encodeURIComponent(gameModeId)}`,
      betasoBackendAuthHeaders(this.apiKey),
    );
    const raw = Array.isArray(response?.levels) ? (response.levels as RawLevel[]) : [];
    // SE FILTRA LO QUE NO ES UN NIVEL en vez de rechazar la lista entera, y es lo que hace v1:
    // una fila mal cargada en el panel no puede dejar sin aumentar a una mesa cuyos otros
    // niveles están bien. Lo que NO se hace es completar: un nivel sin `extra` no es un nivel
    // con `extra: 0`, es una fila que alguien cargó mal — y `extra: 0` sería un aumento que
    // cobra y no da puntos.
    //
    // `additionalPoints` SÍ se completa con cero, y la asimetría es la de v1: es un extra sobre
    // el ranking y su ausencia significa «ninguno», mientras que un `extra` ausente significa
    // «no sé cuánto vale este nivel».
    return raw
      .filter((level) => Number.isFinite(level?.level) && Number.isFinite(level?.extra))
      .map((level) => ({
        level: Number(level.level),
        extra: Number(level.extra),
        additionalPoints: Number(level.additionalPoints ?? 0),
      }));
  }
}
