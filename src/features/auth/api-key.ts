import { API_KEY_HEADER } from "@/shared/http/api-key";

// LA OTRA MITAD de la autenticación: lo que el dominó presenta cuando el que pregunta es él mismo y
// no un jugador. El backend de Betaso lo exige en sus rutas internas. Es la llave de SALIDA; la de
// ENTRADA —la que nos presenta el panel— es otro secreto, con la puerta en `shared/http/api-key.ts`,
// que es también donde se escribe el header de las dos.
//
// La distinción con el token de un jugador es de fondo: con la llave la pregunta es «¿qué sabés de
// este torneo?»; con el token del jugador es «¿el que se conecta está inscripto?». Contestar la
// segunda con credenciales de servidor la convertiría en «¿alguien con este id está inscripto?», que
// no es lo mismo.

// Un secreto presentado en ese header. QUIÉN se lo presenta A QUIÉN se dice en cada uso, que es el
// único lugar donde se puede decir: la forma es la misma a la ida y a la vuelta.
export interface ApiKey {
  readonly value: string;
}

// Los headers de una llamada que NOSOTROS le hacemos al backend de Betaso.
export function betasoBackendAuthHeaders({ value }: ApiKey): Record<string, string> {
  return { [API_KEY_HEADER]: value };
}
