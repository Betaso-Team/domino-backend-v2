import { type ApiKey, betasoBackendAuthHeaders } from "@/features/auth";
import type { HttpClient } from "@/shared/http";
import type { AntifraudFlag } from "../antifraud-flag";

/**
 * THE SWITCH, read from the main backend where it lives. With the server's API
 * key: the question is the truco's and not a player's.
 *
 * Mind the direction: this file is OUTBOUND — the truco asking — while the
 * `http/` folder next door is INBOUND, the truco answering. They share a
 * protocol and nothing else.
 *
 * **It catches nothing, and that is the point.** A network failure has to COME OUT of here so the
 * caching layer can catch it and decide what to do: assume ON. If this returned
 * `false` on error, whoever can take that endpoint down would turn the
 * antifraude off.
 */
export class HttpAntifraudFlag implements AntifraudFlag {
  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: ApiKey,
  ) {}

  async isRematchRulesEnabled(): Promise<boolean> {
    const response = await this.http.get<{ enabled?: boolean }>(
      "antifraud-settings/rematch-enabled",
      betasoBackendAuthHeaders(this.apiKey),
    );
    return response?.enabled === true;
  }
}
