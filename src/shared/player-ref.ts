// LA IDENTIDAD DE NEGOCIO, y la forma mínima que auth y match comparten.
//
// No es `userId`. El Betaso corre varios productos sobre el mismo espacio de UUIDs, así que
// un `userUuid` suelto puede nombrar a dos personas distintas —con dos billeteras distintas—
// y una identidad global autorizaría a una en la mesa de la otra. La pareja es lo que hace
// que "quién es" tenga una sola respuesta.
//
// Vive en `shared/` y no en `features/auth/` porque el core del match la nombra, y el core
// solo puede importar de su propia feature y de acá (Regla 1). Es una interfaz pelada a
// propósito: lo que viaje adentro de una partida es el id OPACO del asiento, no esto.
export interface PlayerRef {
  readonly platformId: string;
  readonly userUuid: string;
}
