/** Identidad mínima que el dominio necesita conocer del principal autenticado. */
export interface Identity {
  readonly userId: string;
}

/** Puerto de autenticación: el match no depende del formato ni del emisor del token. */
export interface TokenVerifier {
  verify(token: string | undefined): Promise<Identity>;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Token inválido: ${reason}`);
    this.name = "InvalidTokenError";
  }
}
