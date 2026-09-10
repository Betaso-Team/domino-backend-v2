// El negocio usa el reloj SOLO para escribir: calcula `now() + duración` y lo estampa
// en MatchState.activeDeadline. NUNCA lee el tiempo para decidir, así que no compara
// now() contra un deadline (spec §3.4 de truco).
export interface Clock {
  now(): number;
}
