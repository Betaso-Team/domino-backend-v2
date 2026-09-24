import { Mongo } from "@/shared/mongo";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMaintenanceBook } from "../transports/mongo-maintenance";

// A CONTRACT test against a REAL Mongo, for the same reason as the catalog's: what has to be right is
// the shape of the document the product panel writes, and a fake driver does not test that. The
// documents here are copied from v1's schema: the key of its own, the flag and its message. If that
// schema changes, this test is what finds out.
const COLLECTION = "test_truco_settings";

// The singleton's KEY, exactly as v1 declares it: an `id` field with a unique index, not the `_id`.
const ID = { id: "truco_settings" };

// ⚠ PIDE UN MONGO DE VERDAD: lee `MONGO_INT_URI` y se saltea sin ella. El porqué —y por qué
// no es `MONGO_URI`— está en `src/tests/int-services.ts`, que es el único que la lee.
describe.skipIf(!MONGO_INT_URI)("MongoMaintenanceBook (contrato con los ajustes de v1)", () => {
  let mongo: Mongo;
  let book: MongoMaintenanceBook;

  const insert = async (document: Record<string, unknown>) =>
    (await mongo.collection(COLLECTION)).insertOne(document);

  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
    book = new MongoMaintenanceBook(mongo, COLLECTION, new MemoryLogger());
  });

  afterAll(async () => {
    await (await mongo.collection(COLLECTION)).drop().catch(() => {});
    await mongo.close();
  });

  beforeEach(async () => {
    await (await mongo.collection(COLLECTION)).deleteMany({});
  });

  it("lee el interruptor y el mensaje con los nombres de v1", async () => {
    await insert({ ...ID, isUnderMaintenance: true, maintenanceMessage: "volvemos a las 18" });

    expect(await book.current()).toEqual({
      isUnderMaintenance: true,
      message: "volvemos a las 18",
    });
  });

  it("el interruptor apagado deja el juego abierto", async () => {
    await insert({ ...ID, isUnderMaintenance: false, maintenanceMessage: "volvemos a las 18" });

    expect(await book.current()).toEqual({ isUnderMaintenance: false, message: "" });
  });

  // An empty collection is an installation that never turned maintenance on and not one that could
  // not be read. Telling them apart matters: confusing them would close the game on the day product
  // has not created the document yet.
  it("sin documento el juego está abierto", async () => {
    expect(await book.current()).toEqual({ isUnderMaintenance: false, message: "" });
  });

  // The message degrades to empty; the flag does not. A maintenance with no text is a maintenance all
  // the same.
  it("el mantenimiento sin mensaje sigue siendo mantenimiento", async () => {
    await insert({ ...ID, isUnderMaintenance: true });

    expect(await book.current()).toEqual({ isUnderMaintenance: true, message: "" });
  });

  // It is looked up by v1's key and not by "the first document there is": the collection is a
  // singleton indexed by that field, and the filter is what keeps the adapter safe from an intruding
  // document — which is exactly the one that could leave the game closed with nobody having asked.
  it("ignora un documento que no sea el de los ajustes", async () => {
    await insert({ id: "otra-cosa", isUnderMaintenance: true, maintenanceMessage: "no es este" });

    expect(await book.current()).toEqual({ isUnderMaintenance: false, message: "" });
  });

  // It fails OPEN, and it is the decision that shows the most: a database hiccup locking everyone out
  // of the game is far worse than a maintenance starting a few seconds late.
  it("si no se puede leer la base, el juego sigue abierto", async () => {
    const roto = new MongoMaintenanceBook(
      new Mongo("mongodb://127.0.0.1:1/nada?serverSelectionTimeoutMS=50"),
      COLLECTION,
      new MemoryLogger(),
    );

    expect(await roto.current()).toEqual({ isUnderMaintenance: false, message: "" });
  });
});
