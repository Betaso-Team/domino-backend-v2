// The feature's public surface: the config, the pure rules, the stateful pieces, the ports, the
// events and today's implementations. Nothing outside reaches the inside.
export type { QualityStep, TournamentConfig } from "./config";
export { DEFAULT_TOURNAMENT_CONFIG } from "./config";
export type { TournamentClient, TournamentInfo, TournamentStatus } from "./client";
export { TournamentUnavailableError } from "./client";
export type { TournamentEvent } from "./events";
export type { MatchQuality } from "./quality";
export { computeQuality, gradeOf } from "./quality";
export type { Participation, ParticipationTransport } from "./participation";
export { ParticipationReporter } from "./participation";
export { TournamentWatcher } from "./watcher";
export type { TournamentWatcherDeps } from "./watcher";
export type { Penalty } from "./penalty";
export { StrikeBook, penaltyMinutesFor } from "./penalty";
export { type TournamentHttpDeps, tournamentHttp } from "./transports/http/register";
export { HttpTournamentClient } from "./transports/http-client";
export { CachedTournamentClient } from "./transports/cached-client";
export { AmqpParticipationTransport } from "./transports/amqp-participation";
