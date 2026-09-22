// The tournament's configuration on the truco's side. Every number here is ANTIFRAUDE tuning, which
// is exactly what product will want to move without waiting for a deploy.
//
// Mind what is NOT here: `pointsPerWin`. The panel allows configuring it and the main backend serves
// it to the player, but this server IGNORES it — the winner's score comes entirely from the quality
// scale. It stays out of the config on purpose: nobody being able to read it is what guarantees
// nobody believes it does something. `pointsPerLoss` is respected, and comes from the tournament.

/** One rung of the quality scale: from this ratio up, this many points. */
export interface QualityStep {
  readonly minRatio: number;
  readonly points: number;
}

export interface TournamentConfig {
  // What a COMPLETE match of truco is expected to look like, which the one played is measured
  // against.
  readonly avgRounds: number;
  /**
   * CALIBRATED, not chosen: it is what a normal match takes, and the quality
   * ratio divides by it.
   *
   * Which means it is not independent of the game's pace. Anything that makes a
   * match take longer — a longer turn, a longer pause between rounds — inflates
   * every duration ratio, and the axis stops telling a real match from a short
   * one. When the pace changes, this gets measured again; leaving it stale
   * quietly degrades a two-axis formula into a one-axis one.
   */
  readonly avgDurationMinutes: number;

  // The scale, from most to least demanding. A LIST and not a single threshold because a win is not
  // binary: between "played a normal match" and "disconnected instantly" there are degrees, and
  // flattening that to a yes/no is exactly what let a walkout pass as a cheap win.
  readonly qualityScale: readonly QualityStep[];

  // From WHICH walkout the penalty applies. At 2, the SECOND one already does.
  readonly minStrikesForPenalty: number;
  // Minutes per rung: at 10, the 2nd walkout is 10 min, the 3rd 20, the Nth 10 × (N−1).
  readonly penaltyMinutesPerStrike: number;
  // How long the walkout counter lives before being forgotten. Every new strike renews it, so it
  // punishes sustained repetition and forgives whoever walked out once a day ago.
  readonly strikesDecayMs: number;

  // HOW OFTEN the main backend is told whether a tournament has matches left. Not a network timeout
  // but the pace at which a payout is unblocked: the tournament is over and the only thing missing
  // for it to hand out prizes is the truco saying nobody is still playing.
  readonly gamesCheckIntervalMs: number;

  // TO HOW MANY PIEDRAS a tournament match is played, by seat count. It is here because it is not on
  // the other side: the main backend serves no field with this. Until the tournament says so, the
  // honest alternative is for this server to say it, in the same place as everything else product
  // will want to move without a deploy.
  readonly pointsToWinBySeats: Readonly<Record<number, number>>;

  // At what quality or below the pair is vetoed: a match that lasted nothing between the same two is
  // the pattern being discouraged. The DECISION — the threshold — lives here; how long the veto
  // lasts and where it is recorded belongs to matchmaking, which applies it.
  readonly vetoMaxQuality: number;
}

const MINUTES = 60_000;
const HOURS = 60 * MINUTES;

export const DEFAULT_TOURNAMENT_CONFIG: TournamentConfig = {
  avgRounds: 6.31,
  // ESTIMATED, not measured: the previous 3.3 was, and the pauses between vueltas and rounds grew
  // by about half a minute over a whole match. It stays on the low side deliberately — being too
  // high makes the scale stricter, and that error lands on the honest player, while being too low
  // only loosens an axis that the rounds one already covers.
  avgDurationMinutes: 3.9,
  qualityScale: [
    { minRatio: 0.8, points: 3 }, // partida completada normalmente
    { minRatio: 0.3, points: 2 }, // ambiguo: puede ser una desconexión real
    { minRatio: 0.1, points: 1 }, // abandono temprano sospechoso
    { minRatio: 0, points: 0 }, // abandono inmediato: no cuenta como victoria
  ],
  minStrikesForPenalty: 2,
  penaltyMinutesPerStrike: 10,
  strikesDecayMs: 24 * HOURS,
  // The same numbers as the catalog's casual tables.
  gamesCheckIntervalMs: 2 * MINUTES,
  pointsToWinBySeats: { 2: 12, 4: 24 },
  vetoMaxQuality: 1,
};
