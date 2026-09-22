import { type Maintenance, type MaintenanceBook, OPEN } from "../maintenance";

// The switch from CONFIGURATION: the value arrives given and does not change. The sibling of the
// configured catalog, and it serves the same purpose — bringing the server up with no database — and
// the suite, where a maintenance is a fact of the test.
//
// Immutable on purpose, like the catalog: a switch anyone could move from outside is exactly what is
// not wanted in the process that decides who gets in to play.
export class ConfigMaintenanceBook implements MaintenanceBook {
  constructor(private readonly value: Maintenance = OPEN) {}

  async current(): Promise<Maintenance> {
    return this.value;
  }
}
