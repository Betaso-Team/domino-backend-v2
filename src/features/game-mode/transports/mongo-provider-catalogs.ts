import type { Collection, IndexDescription } from "mongodb";
import {
  type CatalogSource,
  type ProviderCatalog,
  type ProviderCatalogRepository,
  defaultCatalogOf,
} from "../core/catalog";
import type { Clock, CollectionSource } from "./mongo-repository";

// LA COLECCIÓN DE LAS FUENTES, una constante por el mismo argumento que `GAME_MODE_COLLECTION`: el
// dominó es su único escritor y un nombre configurable sería un catálogo que se descubre vacío.
export const PROVIDER_CATALOG_COLLECTION = "provider_catalogs";

// Un documento por proveedor que alguna vez cambió su fuente. Ausente = `shared`.
interface ProviderCatalogDocument {
  providerId: string;
  source: CatalogSource;
  updatedAt: Date;
  updatedBy: string;
}

const INDEXES: IndexDescription[] = [
  { key: { providerId: 1 }, name: "providerId_1", unique: true },
];

export class MongoProviderCatalogs implements ProviderCatalogRepository {
  private prepared?: Promise<Collection<ProviderCatalogDocument>>;

  constructor(
    private readonly source: CollectionSource,
    private readonly clock: Clock,
  ) {}

  async of(providerId: string): Promise<ProviderCatalog> {
    const found = await (await this.collection()).findOne({ providerId });
    return found ? catalogOf(found) : defaultCatalogOf(providerId);
  }

  async nonShared(): Promise<readonly ProviderCatalog[]> {
    const found = await (await this.collection())
      .find({ source: { $ne: "shared" } })
      .sort({ providerId: 1 })
      .toArray();
    return found.map(catalogOf);
  }

  // UN UPSERT POR PROVEEDOR: el índice único de `providerId` deja un documento por proveedor aunque
  // dos instancias escribieran a la vez (el lease del escritor ya lo evita).
  async set(
    providerId: string,
    source: CatalogSource,
    updatedBy: string,
  ): Promise<ProviderCatalog> {
    const document: ProviderCatalogDocument = {
      providerId,
      source,
      updatedAt: new Date(this.clock.now()),
      updatedBy,
    };
    await (await this.collection()).updateOne({ providerId }, { $set: document }, { upsert: true });
    return catalogOf(document);
  }

  private collection(): Promise<Collection<ProviderCatalogDocument>> {
    this.prepared ??= this.prepare().catch((error: unknown) => {
      this.prepared = undefined;
      throw error;
    });
    return this.prepared;
  }

  private async prepare(): Promise<Collection<ProviderCatalogDocument>> {
    const collection = await this.source.collection<ProviderCatalogDocument>(
      PROVIDER_CATALOG_COLLECTION,
    );
    await collection.createIndexes(INDEXES);
    return collection;
  }
}

// Campo por campo: el `_id` no sale del adaptador.
function catalogOf(document: ProviderCatalogDocument): ProviderCatalog {
  return {
    providerId: document.providerId,
    source: document.source,
    updatedAt: document.updatedAt,
    updatedBy: document.updatedBy,
  };
}
