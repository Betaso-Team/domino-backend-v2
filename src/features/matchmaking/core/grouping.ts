export interface GroupingTicket {
  readonly playerId: string;
  readonly enqueuedAt: number;
  readonly avoid: readonly string[];
}

// WHO PLAYS TOGETHER, and in what order. The pure matchmaking rule: it knows neither the transport,
// nor the queue, nor the scope — it takes whoever is waiting and returns a group or nothing.
//
// It does two things, and the second is the one that can fail silently:
//
//  1. CHOOSING. It prefers groups with no vetoes among their members; when none is possible and
//     whoever waited longest is past their grace period, it pairs them anyway. A veto DELAYS, it
//     never prevents.
//  2. ORDERING. The order of the seat list **IS the team assignment**: the room hands out teams by
//     index, so `[a,b,c,d]` means a+c against b+d. Handing the four over in arrival order forms pairs
//     by accident, and the mistake is invisible: the match runs perfectly, with the wrong partners.

export interface GroupingOptions {
  readonly seats: number;
  readonly now: number;
  readonly vetoBypassMs: number;
  readonly candidates: number;
}

/**
 * The chosen group, ALREADY ORDERED into seats.
 *
 * @returns `undefined` when no group is possible yet; the next tick looks again.
 */
export function formGroup<T extends GroupingTicket>(
  waiting: readonly T[],
  options: GroupingOptions,
): readonly T[] | undefined {
  const { seats } = options;
  if (waiting.length < seats) return undefined;

  // Longest waiting first. The queue usually arrives that way already, but sorting here is what
  // keeps the rule from depending on the caller having remembered.
  const byArrival = [...waiting].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const pool = byArrival.slice(0, Math.max(seats, options.candidates));

  const clean = firstCombination(pool, seats, (group) => !hasVeto(group));
  if (clean) return seatOrderOf(clean);

  // No clean group exists. The veto is broken only once whoever waited longest is past their grace
  // period: that is the guarantee that nobody is left hanging by the antifraude. Until then it keeps
  // waiting — with a healthy pool, someone vetoed with nobody turns up within seconds.
  const longestWait = options.now - (byArrival[0]?.enqueuedAt ?? options.now);
  if (longestWait < options.vetoBypassMs) return undefined;
  return seatOrderOf(pool.slice(0, seats));
}

// Is any pair inside the group vetoed? ALL pairs are looked at and not only rivals: the veto is
// between ACCOUNTS — who crossed paths — so at a table of four two accomplices landing as partners
// counts too.
function hasVeto(group: readonly GroupingTicket[]): boolean {
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i] as GroupingTicket;
      const b = group[j] as GroupingTicket;
      if (a.avoid.includes(b.playerId) || b.avoid.includes(a.playerId)) return true;
    }
  return false;
}

// The first subset of size `size` that satisfies the predicate, walked in lexicographic order over a
// list already sorted by arrival. That order is what makes the result prefer whoever waited longest
// without having to score anything.
function firstCombination<T extends GroupingTicket>(
  pool: readonly T[],
  size: number,
  accepts: (group: readonly T[]) => boolean,
): readonly T[] | undefined {
  const chosen: T[] = [];

  const walk = (from: number): readonly T[] | undefined => {
    if (chosen.length === size) return accepts(chosen) ? [...chosen] : undefined;
    for (let i = from; i < pool.length; i++) {
      // Not enough left to complete it: this branch is not worth following.
      if (pool.length - i < size - chosen.length) break;
      chosen.push(pool[i] as T);
      const found = walk(i + 1);
      chosen.pop();
      if (found) return found;
    }
    return undefined;
  };

  return walk(0);
}

// Lays the chosen out into seats. The room alternates team by index — evens to A, odds to B — so
// arrival order ALREADY produces the interleaving: in 2v2 the 1st and 3rd of the queue play the 2nd
// and the 4th.
//
// Being the identity does not make it a detail: it is the decision, and it has its reason. Two
// accomplices who queue at the same moment land in consecutive positions, that is, on OPPOSING teams.
// Grouping them as [1st, 2nd] against [3rd, 4th] would do the opposite — whoever arrives together
// would always be partners — which is exactly what a pair of coordinated accounts would want.
//
// The day there is a ranking, this is the only place that changes.
function seatOrderOf<T extends GroupingTicket>(group: readonly T[]): readonly T[] {
  return [...group];
}
