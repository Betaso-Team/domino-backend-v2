import { MemoryPlayerStats } from "./memory-player-stats";
import { playerStatsContract } from "./tests/player-stats-contract";

// EL MISMO CONTRATO QUE EL ADAPTADOR DE MONGO (`./mongo-player-stats.int.test.ts`).
playerStatsContract(() => new MemoryPlayerStats());
