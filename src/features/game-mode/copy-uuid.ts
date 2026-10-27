import { createHash } from "node:crypto";

// EL UUID DE LA COPIA DE UN MODO COMPARTIDO A UN OPERADOR: v5 (RFC 4122, SHA-1) con el uuid del
// modo de origen como espacio de nombres y el id del operador como nombre. Determinista a propósito:
// es lo que hace que reintentar una copia a medias complete lo que faltó en vez de duplicar, y que
// dos instancias que copian lo mismo lleguen al mismo documento.
//
// Con `node:crypto` y no con el paquete `uuid`: son quince líneas del RFC, y el repo no lo usa en
// ningún otro lado (los v4 salen de `randomUUID()`).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El v5 de `name` en el espacio `namespace`, o `undefined` si `namespace` no es un UUID: el catálogo
 * no le exige forma de UUID al `uuid` de un modo (`schemas.ts`), y un espacio de nombres que no son
 * dieciséis bytes no tiene v5.
 */
export function uuidV5(namespace: string, name: string): string | undefined {
  if (!UUID.test(namespace)) return undefined;
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  // La versión (5) en el nibble alto del byte 6 y la variante RFC 4122 (10xx) en el byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
