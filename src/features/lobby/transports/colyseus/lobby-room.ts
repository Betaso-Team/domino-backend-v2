import { type AuthContext, type Client, Room, matchMaker } from "colyseus";
import { rootContainer } from "../../../../di-container.js";
import type { Logger } from "../../../../logger.js";
import type { TokenVerifier } from "../../../auth/index.js";
import { DEFAULT_MAINTENANCE_MESSAGE, GameModeCount, LobbyRoomState } from "../../core/state.js";
import { LobbySettings } from "../../settings.js";

interface DominoRoomMetadata {
  readonly gameModeId?: string;
}

// Es una Room normal a propósito: LobbyRoom de Colyseus usa el canal global `$lobby`, que Redis
// comparte entre bases y productos. El query queda aislado por la base elegida por REDIS_URL.
export class LobbyRoom extends Room<{ state: LobbyRoomState; client: Client }> {
  declare state: LobbyRoomState;
  private settings!: LobbySettings;
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
      const [rooms, maintenance] = await Promise.all([
        matchMaker.query({ name: "domino" }),
        this.settings.get(),
      ]);
      this.applyCounts(rooms);
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

  private applyCounts(rooms: Awaited<ReturnType<typeof matchMaker.query>>): void {
    let totalPlayers = 0;
    const byMode = new Map<string, number>();

    for (const room of rooms) {
      if (room.clients <= 0) continue;
      totalPlayers += room.clients;
      const gameModeId = (room.metadata as DominoRoomMetadata | undefined)?.gameModeId;
      if (gameModeId) byMode.set(gameModeId, (byMode.get(gameModeId) ?? 0) + room.clients);
    }

    this.state.totalPlayers = totalPlayers;
    this.state.gameModesCount.clear();
    for (const [gameModeName, playerCount] of [...byMode].sort(([a], [b]) => a.localeCompare(b))) {
      const count = new GameModeCount();
      count.gameModeName = gameModeName;
      count.playerCount = playerCount;
      this.state.gameModesCount.push(count);
    }
  }
}
