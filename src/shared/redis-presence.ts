import { RedisPresence } from "colyseus";
import type { KeyValueStore } from "./kv";

// EL COMPARE-AND-DELETE DE REDIS: un script corre entero sin que otro comando se intercale, así que
// entre el `GET` y el `DEL` nadie puede escribir la clave.
export const COMPARE_AND_DELETE_LUA = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

// EL PRESENCE DE COLYSEUS MÁS LOS DOS COMANDOS QUE LE FALTAN AL REGISTRO. Es una subclase y no un
// envoltorio porque la conexión (`pub`) es `protected`: así se reusa la misma conexión que Colyseus
// ya abre, sin una tercera conexión a Redis por proceso, y el resto de `KeyValueStore` sigue encajando
// por estructura (ver `kv.ts`).
export class DominoRedisPresence
  extends RedisPresence
  implements Pick<KeyValueStore, "delIfEquals" | "setIfAbsent">
{
  async setIfAbsent(key: string, value: string, seconds: number): Promise<boolean> {
    return (await this.pub.set(key, value, "EX", seconds, "NX")) === "OK";
  }

  async delIfEquals(key: string, value: string): Promise<boolean> {
    return Number(await this.pub.eval(COMPARE_AND_DELETE_LUA, 1, key, value)) === 1;
  }
}
