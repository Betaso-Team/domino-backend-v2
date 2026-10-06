// LOS PERILLAS, compartidas con todos los motores que sirve el backend principal: la ventana sin
// rake, la ventana de emparejamiento blando, y el techo de winrate que decide quién cuenta como
// "shark" para ella.

export interface CoreLoopSettings {
  readonly enabled: boolean;
  readonly rake0Matches: number;
  readonly softWindowMatches: number;
  readonly winrateCeiling: number;
  readonly minSampleForWinrateFilter: number;
  readonly softTimeoutSeconds: number;
}

export interface CoreLoopSettingsSource {
  settings(): Promise<CoreLoopSettings>;
}

/**
 * LA FEATURE APAGADA, en números. La comparten el transporte (una respuesta parcial o mal formada
 * cae a esto campo por campo) y la cache (una fuente que no contesta cae a esto entero): un
 * `winrateCeiling` inventado en 0 filtraría con un dato que no significa nada, así que fallar acá es
 * fallar con el filtro APAGADO, no con una suposición.
 */
export const NEUTRAL_CORE_LOOP_SETTINGS: CoreLoopSettings = {
  enabled: false,
  rake0Matches: 0,
  softWindowMatches: 0,
  winrateCeiling: 1,
  minSampleForWinrateFilter: Number.POSITIVE_INFINITY,
  softTimeoutSeconds: 0,
};
