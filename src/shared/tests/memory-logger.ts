import type { LogFields, Logger } from "../logger";

// EL LOGGER DE LA SUITE, para los pocos tests que ASERTAN sobre lo que se registró. El resto no lo
// necesita: el nivel del entorno de test silencia al real, que entonces no escribe nada.
//
// Es un DOBLE y no un adaptador, a diferencia de `MemoryKeyValueStore` o `MemoryLedger`: ningún
// despliegue del dominó elige no tener log. Por eso vive en `tests/` y no en `shared/` a secas.

export type LoggedLevel = "debug" | "info" | "warn" | "error";

export interface LoggedLine {
  readonly level: LoggedLevel;
  readonly msg: string;
  readonly fields: LogFields;
}

export class MemoryLogger implements Logger {
  constructor(
    private readonly bindings: LogFields = {},
    // UN HIJO COMPARTE EL MISMO ARREGLO: un test que asierta sobre las líneas quiere ver todo lo
    // que pasó, no solo lo que salió por el logger que él tiene en la mano. Con un arreglo por
    // hijo, un `log.child({ matchId }).error(...)` —que es como registra media feature— quedaría
    // invisible para el test que sostiene al padre.
    readonly lines: LoggedLine[] = [],
  ) {}

  readonly debug = this.at("debug");
  readonly info = this.at("info");
  readonly warn = this.at("warn");
  readonly error = this.at("error");

  child(fields: LogFields): Logger {
    return new MemoryLogger({ ...this.bindings, ...fields }, this.lines);
  }

  /** Las líneas de un nivel, que es como casi siempre se las mira. */
  at_(level: LoggedLevel): readonly LoggedLine[] {
    return this.lines.filter((line) => line.level === level);
  }

  private at(level: LoggedLevel) {
    return (msg: string, fields: LogFields = {}): void => {
      this.lines.push({ level, msg, fields: { ...this.bindings, ...fields } });
    };
  }
}
