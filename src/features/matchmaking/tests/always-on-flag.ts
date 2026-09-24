import type { AntifraudFlag } from "../antifraud-flag";

// THE SWITCH, ON AND THAT IS ALL. Its only consumer is the suite, which is why it lives on this side.
export class AlwaysOnAntifraudFlag implements AntifraudFlag {
  async isRematchRulesEnabled(): Promise<boolean> {
    return true;
  }
}
