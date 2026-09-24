import type { Logger } from "@/shared/logger";
import type { Mongo } from "@/shared/mongo";
import { type Maintenance, type MaintenanceBook, OPEN } from "../maintenance";

// THE MAINTENANCE FLAG, read from where v1 already keeps it: its collection of global truco settings.
// READ ONLY — the switch is moved by the product panel and not by this server — hence no version mark.
//
// The SAME collection as v1, on purpose: with both versions live, a maintenance that only turned one
// of them off is not a maintenance. The name is configurable for the same reason as the table
// catalog's: it is not ours.
//
// The collection is a SINGLETON with a key of its own: v1 indexes it by an `id` field — not by `_id`
// — with a unique index, and its service always finds and creates it by that value. It is looked up
// the same way here: that is the key the other repo guarantees, and filtering by it keeps this
// adapter safe from a second document nobody imagined would exist.
//
// The id's VALUE happens to match the collection's default name, but they are not the same thing: the
// name is configurable because it is not ours, and this id is part of v1's schema. Hence a constant
// and not the collection name.
const SETTINGS_ID = "domino_settings";

// The document carries more than we read — v1's three timeouts — and none of it is useful: ours come
// from `GlobalTrucoConfig`. Only what is looked at is declared.
interface SettingsDocument {
  readonly isUnderMaintenance?: boolean;
  readonly maintenanceMessage?: string;
}

export class MongoMaintenanceBook implements MaintenanceBook {
  constructor(
    private readonly mongo: Mongo,
    private readonly collectionName: string,
    private readonly log: Logger,
  ) {}

  async current(): Promise<Maintenance> {
    try {
      const document = await (
        await this.mongo.collection<SettingsDocument>(this.collectionName)
      ).findOne({ id: SETTINGS_ID });
      // With no document the game is OPEN: v1 creates the settings lazily the first time anyone asks
      // for them, so their absence is an installation that never touched them and not one that could
      // not be read.
      if (!document?.isUnderMaintenance) return OPEN;
      return { isUnderMaintenance: true, message: document.maintenanceMessage ?? "" };
    } catch (e) {
      // It fails OPEN and SAYS SO. Keeping quiet would be the worst of both worlds: the game stays
      // open during a maintenance and nobody finds out why.
      this.log.error("no se pudo leer el mantenimiento", {
        err: e,
        collection: this.collectionName,
      });
      return OPEN;
    }
  }
}
