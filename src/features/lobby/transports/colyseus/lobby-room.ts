import { rootContainer } from "@/di-container";
import type { TokenVerifier } from "@/features/auth";
import type { Logger } from "@/logger";
import { type AuthContext, type Client, Room } from "colyseus";
import { DEFAULT_MAINTENANCE_MESSAGE, GameModeCount, LobbyRoomState } from "../../core/state";
import { LobbySettings } from "../../settings";

interface MatchCensus {
  census(): Promise<{
    readonly playersInMatch: number;
    readonly byGameMode: ReadonlyMap<string, number>;
  }>;
}

// Es una Room normal a propósito: LobbyRoom de Colyseus usa el canal global `$lobby`, que Redis
// comparte entre bases y productos. El censo queda aislado por la base elegida por REDIS_URL.
export class LobbyRoom extends Room<{ state: LobbyRoomState; client: Client }> {
  declare state: LobbyRoomState;
  private settings!: LobbySettings;
  private matches!: MatchCensus;
  private log!: Logger;
  private refreshing = false;

  static override async onAuth(
    _token: string,
    _options: unknown,
    _context: AuthContext,
  ): Promise<true> {
    return true;
  }

  override async onCreate(): Promise<void> {
    this.autoDispose = false;
    this.setState(new LobbyRoomState());
    this.settings = rootContainer.resolve(LobbySettings);
    this.matches = rootContainer.resolve<MatchCensus>("MatchCensus");
    this.log = rootContainer.resolve<Logger>("Logger");
    await this.refresh();
    this.clock.setInterval(() => void this.refresh(), 1_000);
  }

  override async onAuth(
    _client: Client,
    _options: unknown,
    context: AuthContext,
  ): Promise<Awaited<ReturnType<TokenVerifier["verify"]>>> {
    return rootContainer.resolve<TokenVerifier>("TokenVerifier").verify(context.token ?? undefined);
  }

  override onJoin(): void {
    this.state.playersInLobby = this.clients.length;
    void this.refresh();
  }

  override onLeave(): void {
    this.state.playersInLobby = this.clients.length;
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const [census, maintenance] = await Promise.all([this.matches.census(), this.settings.get()]);
      this.applyCounts(census);
      this.state.isUnderMaintenance = maintenance.isUnderMaintenance;
      this.state.maintenanceMessage = maintenance.maintenanceMessage;
    } catch (error: unknown) {
      this.state.isUnderMaintenance = true;
      this.state.maintenanceMessage = DEFAULT_MAINTENANCE_MESSAGE;
      this.log.error("no se pudo refrescar el lobby", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.refreshing = false;
    }
  }

  private applyCounts(census: Awaited<ReturnType<MatchCensus["census"]>>): void {
    this.state.totalPlayers = census.playersInMatch;
    this.state.gameModesCount.clear();
    for (const [gameModeName, playerCount] of [...census.byGameMode].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const count = new GameModeCount();
      count.gameModeName = gameModeName;
      count.playerCount = playerCount;
      this.state.gameModesCount.push(count);
    }
  }
}
