import jwt from "jsonwebtoken";

// LA PAREJA DE CLAVES DE BILLING-AUTH DE LA SUITE Y DEL SMOKE. Fija y PUBLICADA a propósito: con
// HS256 fuera, los tests firman como firma billing-auth (ES256), y para eso necesitan la privada.
// Ningún entorno de verdad confía en esta pública: el suyo trae la de su billing-auth
// (`BILLING_AUTH_PUBLIC_KEY`). `vitest.setup.ts` y `compose.smoke.yaml` usan esta.
export const TEST_BILLING_AUTH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECA+1agnfjWJeneGON5dirYjnShiD
MG7S65FJUbx3H9OWgE79m9n1e27UMWVhrNNk+fLAoaBoqRG6RtbdZuhtEw==
-----END PUBLIC KEY-----
`;

const TEST_BILLING_AUTH_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTIDb7mNB4y1P4mNa
RjBrn1owiCQ34XA1MYAnLWJ5tIKhRANCAAQID7VqCd+NYl6d4Y43l2KtiOdKGIMw
btLrkUlRvHcf05aATv2b2fV7btQxZWGs02T58sChoGipEbpG1t1m6G0T
-----END PRIVATE KEY-----
`;

/** Un token de jugador como lo firma billing-auth: ES256, `betaso-auth`, las dos audiencias y `game`. */
export function mintBillingToken(userId: string, expiresIn: jwt.SignOptions["expiresIn"] = "1h") {
  return jwt.sign({ sub: userId, game: "domino" }, TEST_BILLING_AUTH_PRIVATE_KEY, {
    algorithm: "ES256",
    issuer: "betaso-auth",
    audience: ["orchestrator", "domino"],
    expiresIn,
  });
}
