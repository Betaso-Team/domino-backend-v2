import { type ApiKey, betasoBackendAuthHeaders } from "@/features/auth";
import type { HttpClient } from "@/shared/http";
import {
  type CoreLoopSettings,
  type CoreLoopSettingsSource,
  NEUTRAL_CORE_LOOP_SETTINGS,
} from "../settings";
import type { CoreLoopSettle, CoreLoopSettleInput, CoreLoopSettleResult } from "../settle";

/**
 * EL CLIENTE DE VERDAD, contra el backend principal donde vive core-loop. Con la llave del servidor:
 * la pregunta es del dominó y no de un jugador. El contrato es el del v1 del dominó
 * (`core-loop/core-loop.service.ts`), con `game: "domino"`.
 *
 * **No atrapa nada, y ése es el punto.** v1 atrapaba adentro y devolvía un Map vacío; acá un fallo
 * de red o un plazo vencido tiene que SALIR para que quien llama decida qué significa "no hubo
 * respuesta" — pagar el premio normal sin perdón de rake. Mismo criterio que `HttpAntifraudFlag`.
 */
export class HttpCoreLoopClient implements CoreLoopSettle, CoreLoopSettingsSource {
  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: ApiKey,
  ) {}

  async settle(
    input: CoreLoopSettleInput,
  ): Promise<{ readonly enabled: boolean; readonly results: readonly CoreLoopSettleResult[] }> {
    const response = await this.http.post<{ enabled?: boolean; results?: CoreLoopSettleResult[] }>(
      "internal/core-loop/matches/settle",
      { ...input, game: "domino" },
      betasoBackendAuthHeaders(this.apiKey),
    );
    return {
      enabled: response?.enabled === true,
      results: Array.isArray(response?.results) ? response.results : [],
    };
  }

  async settings(): Promise<CoreLoopSettings> {
    const response = await this.http.get<Partial<CoreLoopSettings>>(
      "internal/core-loop/settings",
      betasoBackendAuthHeaders(this.apiKey),
    );
    return { ...NEUTRAL_CORE_LOOP_SETTINGS, ...response };
  }
}
