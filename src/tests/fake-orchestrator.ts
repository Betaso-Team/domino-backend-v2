import type { OrchestratorCharges } from "@/features/match/network/orchestrator-charges";

// EL ORQUESTADOR DE LA SUITE: cobra todo, siempre, salvo que un test le diga otra cosa. Sin él, toda
// mesa por request de la suite —la mayoría— se cerraría sin arrancar, porque nadie contesta el cobro
// de la entrada. El adaptador HTTP de verdad tiene su propio test contra un servidor `node:http`
// (`network/tests/orchestrator-charges.test.ts`); acá se reemplaza el PUERTO, como el resto de la
// suite reemplaza el libro de niveles o los destinos del cierre.
export class FakeOrchestratorCharges implements OrchestratorCharges {
  readonly entries: string[] = [];
  readonly bets: Array<{ matchId: string; step: number; level: number }> = [];
  private entryFailure: (() => Promise<void>) | undefined;

  async chargeEntry(matchId: string): Promise<void> {
    this.entries.push(matchId);
    if (this.entryFailure) await this.entryFailure();
  }

  async chargeBet(matchId: string, step: number, level: number): Promise<void> {
    this.bets.push({ matchId, step, level });
  }

  /** Que el próximo cobro de entrada falle (o cuelgue) así. `undefined` vuelve a cobrar todo. */
  failEntryWith(failure: (() => Promise<void>) | undefined): void {
    this.entryFailure = failure;
  }
}

export const fakeOrchestrator = new FakeOrchestratorCharges();
