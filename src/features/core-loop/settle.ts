// EL PUERTO hacia core-loop: la retención de jugadores nuevos del backend principal —rake perdonado
// más una ventana de emparejamiento blando—. Vive en su propia feature y no adentro de `matchmaking`
// ni de `match`, porque las dos lo consumen y ninguna debería depender de la otra para esto. Es el
// `core-loop/` del v1 del dominó (`core-loop.service.ts`), portado con la forma de truco (`fa246ad`).

export interface CoreLoopParticipant {
  readonly userId: string;
  readonly won: boolean;
}

export interface CoreLoopSettleResult {
  readonly userId: string;
  readonly rakeWaived: boolean;
  readonly rake0Remaining: number;
  readonly softWindowRemaining: number;
  readonly alreadySettled: boolean;
}

export interface CoreLoopSettleInput {
  readonly matchId: string;
  readonly currency: string;
  readonly paid: boolean;
  readonly participants: readonly CoreLoopParticipant[];
}

/**
 * LIQUIDA LA PARTIDA Y CONSUME EL BENEFICIO. Una vez por partida resuelta, SIEMPRE —también en las
 * mesas gratis: el contador de la ventana blanda avanza con cada partida liquidada, no sólo con las
 * pagas (v1 lo dice al llamarlo, `domino-room-state.ts:527-530`).
 *
 * @throws lo que lance el transporte ante un fallo de red o un plazo vencido: no atrapa nada, y
 * quien llama decide qué significa "no hubo respuesta".
 */
export interface CoreLoopSettle {
  settle(
    input: CoreLoopSettleInput,
  ): Promise<{ readonly enabled: boolean; readonly results: readonly CoreLoopSettleResult[] }>;
}
