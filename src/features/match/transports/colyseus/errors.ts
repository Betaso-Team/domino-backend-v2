// Rama de la jerarquía que le toca al transporte. Lo que tienen en común: son
// rechazos legítimos, NO bugs, así que la política de errores de la sala los deja
// pasar sin cerrar la partida.
export abstract class ColyseusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ColyseusError {
  constructor(readonly detail: string) {
    super(`Payload inválido: ${detail}`);
  }
}

export class UnknownCommandError extends ColyseusError {
  constructor(readonly type: string) {
    super(`Verbo desconocido: ${type}`);
  }
}

export class SeatNotReservedError extends ColyseusError {
  constructor(playerId: string) {
    super(`${playerId} no tiene asiento en esta partida`);
  }
}

export class PlayerAlreadyOutError extends ColyseusError {
  constructor(playerId: string) {
    super(`${playerId} ya fue retirado de esta partida`);
  }
}
