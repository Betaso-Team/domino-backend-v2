import { type HttpClient, HttpError } from "@/shared/http";
import { API_KEY_HEADER } from "@/shared/http/api-key";
import {
  BET_CHARGE_TIMEOUT_MS,
  CHARGE_DEADLINE_HEADER,
  ChargeRejectedError,
  ENTRY_CHARGE_TIMEOUT_MS,
  type OrchestratorCharges,
  OrchestratorUnavailableError,
} from "../orchestrator-charges";

export interface ChargeTimeouts {
  readonly entryMs: number;
  readonly betMs: number;
}

// LOS COBROS CONTRA EL ORQUESTADOR, por HTTP. `409` es "alguno no pudo pagar" y es una RESPUESTA;
// cualquier otra cosa —un 5xx, un 401 por la llave mal copiada, la red, el plazo— es "no se pudo
// preguntar". Las dos terminan igual para la mesa, pero el log tiene que decir cuál fue: una llave
// mal copiada que se lee como "sin saldo" manda a soporte a mirar billeteras sanas.
export class HttpOrchestratorCharges implements OrchestratorCharges {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly http: HttpClient,
    apiKey: string,
    private readonly timeouts: ChargeTimeouts = {
      entryMs: ENTRY_CHARGE_TIMEOUT_MS,
      betMs: BET_CHARGE_TIMEOUT_MS,
    },
    private readonly now: () => number = Date.now,
  ) {
    this.headers = { [API_KEY_HEADER]: apiKey };
  }

  async chargeEntry(matchId: string): Promise<void> {
    await this.post(`v1/matches/${encodeURIComponent(matchId)}/charges`, {}, this.timeouts.entryMs);
  }

  async chargeBet(matchId: string, step: number, level: number): Promise<void> {
    await this.post(
      `v1/matches/${encodeURIComponent(matchId)}/bets`,
      { step, level },
      this.timeouts.betMs,
    );
  }

  // EL PLAZO QUE SE PROMETE ES EL MISMO CON EL QUE SE ABORTA: `x-charge-deadline` = ahora + `timeoutMs`
  // (epoch ms) y el cliente HTTP corta exactamente a los `timeoutMs`.
  private async post(path: string, body: unknown, timeoutMs: number): Promise<void> {
    const headers = {
      ...this.headers,
      [CHARGE_DEADLINE_HEADER]: String(this.now() + timeoutMs),
    };
    try {
      await this.http.post(path, body, headers, timeoutMs);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        throw new ChargeRejectedError(codeOf(error.body));
      }
      throw new OrchestratorUnavailableError(
        error instanceof HttpError ? `HTTP ${error.status}` : String(error),
      );
    }
  }
}

function codeOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : "REJECTED";
  } catch {
    return "REJECTED";
  }
}
