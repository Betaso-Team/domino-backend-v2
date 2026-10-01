import type { Logger } from "@/shared/logger";
import { ENGINE_VERSION, type Mongo } from "@/shared/mongo";
import { NO_OVERRIDES, type SectionOverrides, type SettingsOverrides } from "../sections";
import type { SettingsBook, SettingsWriter } from "../store";

// LOS OVERRIDES, en la colección donde v1 ya guarda los ajustes globales del dominó —`domino_settings`,
// la misma de donde se lee el interruptor de mantenimiento— y en un DOCUMENTO PROPIO.
//
// La colección se comparte porque ahí viven «los ajustes del dominó». El documento no: el de v1 lo
// escribe su propio servicio, y sus tres plazos (`playerTurnTimeout`, `playerExtraTimeout`,
// `matchmakingTimeout`) no los lee nadie —ni v1: sus salas sólo consultan `isUnderMaintenance`—.
// Escribir los nuestros ahí adentro los mezclaría con campos que parecen vivos y no lo están.
//
// v1 encuentra su singleton por el CAMPO `id` —no por `_id`— con índice único, así que otro valor de
// `id` no puede chocar con él. Portado de truco (`3cab0f8`).
const SETTINGS_ID = "domino_v2_runtime_config";

interface SettingsDocument {
  readonly id: string;
  readonly sections?: Record<string, SectionOverrides>;
}

export class MongoSettings implements SettingsBook, SettingsWriter {
  constructor(
    private readonly mongo: Mongo,
    private readonly collectionName: string,
    private readonly log: Logger,
  ) {}

  // Sin documento no hay overrides: es una instalación que nadie editó, no una falla. Una lectura que
  // FALLA no cae a «sin overrides»: lanza, para que el que sondea se quede con el último valor bueno
  // en vez de devolver en silencio a todo el clúster a los defaults.
  async current(): Promise<SettingsOverrides> {
    const document = await (await this.collection()).findOne({ id: SETTINGS_ID });
    return document?.sections ?? NO_OVERRIDES;
  }

  // UN CAMINO CON PUNTOS POR CAMPO, que es lo que lo hace un parche: lo que no llegó no se lee, no se
  // reescribe y no se pierde, y dos ediciones de campos distintos no se pisan.
  //
  // Las claves vienen de un schema ESTRICTO —una lista blanca—, así que nada de un cuerpo HTTP puede
  // llegar a Mongo como operador ni como un camino propio.
  async save(section: string, patch: SectionOverrides): Promise<SettingsOverrides> {
    const fields: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(patch)) fields[`sections.${section}.${key}`] = value;
    return await this.write({ $set: fields });
  }

  async clear(section: string): Promise<SettingsOverrides> {
    return await this.write({
      $unset: { [`sections.${section}`]: "" },
      $set: { updatedAt: new Date() },
    });
  }

  // El filtro es el `id` SOLO. Con `version` adentro, un upsert intentaría insertar un segundo
  // documento con el mismo `id` y chocaría con el índice único de v1: va en `$setOnInsert`.
  private async write(update: Record<string, unknown>): Promise<SettingsOverrides> {
    const document = await (await this.collection()).findOneAndUpdate(
      { id: SETTINGS_ID },
      { ...update, $setOnInsert: { id: SETTINGS_ID, version: ENGINE_VERSION } },
      { upsert: true, returnDocument: "after" },
    );
    this.log.info("configuración guardada", { sections: Object.keys(document?.sections ?? {}) });
    return document?.sections ?? NO_OVERRIDES;
  }

  private async collection() {
    return await this.mongo.collection<SettingsDocument>(this.collectionName);
  }
}
