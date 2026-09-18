import { describe, expect, it } from "vitest";
import { MemoryGameModeRepository } from "./memory-repository";
import {
  clasica,
  describeGameModeRepositoryContract,
  mutableClock,
} from "./tests/repository-contract";

// EL MISMO CONTRATO QUE EL ADAPTADOR MONGO, corrido contra el adaptador que usa la instancia sin
// Mongo. `MemoryGameModeRepository` NO es un doble de test —igual que `MemoryHistory`, es la
// implementación de una instancia que elige no persistir—, así que si acá los defaults o el orden
// fueran otros, la suite certificaría un comportamiento que la producción no tiene y el catálogo
// saldría al revés en el despliegue que no configuró `MONGO_URI`.
function harness() {
  const clock = mutableClock();
  return { repository: new MemoryGameModeRepository(clock), clock };
}

describeGameModeRepositoryContract("MemoryGameModeRepository", harness);

describe("MemoryGameModeRepository: lo propio de no tener base", () => {
  // EL `id` TIENE QUE PARECER UN `_id` DE MONGO, y no es cosmético: la frontera HTTP lo devuelve
  // como `_id` porque el panel de v1 lo recibía así, y un panel que valide la forma del
  // identificador rechazaría un `mode-1`. Son doce bytes en hex, igual que un ObjectId.
  it("el id tiene la forma de un ObjectId", async () => {
    const { repository } = harness();

    const created = await repository.create(clasica());

    expect(created.id).toMatch(/^[0-9a-f]{24}$/);
  });

  // Nada de lo que devuelve puede ser el objeto que el repositorio guarda: quien reciba un modo y
  // lo mute cambiaría el catálogo de todos sin pasar por `update`, y sin avanzar la revisión que
  // el outbox mira.
  it("lo que devuelve no es el objeto guardado", async () => {
    const { repository } = harness();
    const created = await repository.create(clasica());

    const listed = (await repository.all())[0];
    (listed as { name: string }).name = "Pisada";

    expect((await repository.byUuid(created.uuid))?.name).toBe("Clásica");
  });
});
