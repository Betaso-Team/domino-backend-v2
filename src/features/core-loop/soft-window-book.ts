import type { KeyValueStore } from "@/shared/kv";

// QUIÉN SIGUE EN LA VENTANA DE EMPAREJAMIENTO BLANDO, por jugador. El molde es `CooldownBook`.
//
// Se escribe desde el ÚNICO lugar que ya sabe la cuenta —la respuesta de `settle()`, al cerrar cada
// partida— y nunca se pregunta por su cuenta: core-loop ya lleva el número, esto es sólo una cache
// local para que el emparejador no le pregunte al backend principal en cada entrada a la cola.

export class SoftWindowBook {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly ttlMs: number,
  ) {}

  /**
   * Un remanente en 0 BORRA la nota en vez de escribir un cero: una nota que haya que distinguir de
   * "nunca estuvo" y de "acaba de salir" es una lectura más sin beneficio — las tres contestan `0`.
   */
  async record(playerId: string, remaining: number): Promise<void> {
    if (remaining <= 0) {
      this.kv.del(this.keyOf(playerId));
      return;
    }
    await this.kv.setex(this.keyOf(playerId), String(remaining), Math.round(this.ttlMs / 1000));
  }

  async remainingFor(playerId: string): Promise<number> {
    const raw = await this.kv.get(this.keyOf(playerId));
    return raw ? Number(raw) : 0;
  }

  private keyOf(playerId: string): string {
    return `core_loop_soft_window:${playerId}`;
  }
}
