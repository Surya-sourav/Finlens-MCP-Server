import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Self-contained, HMAC-signed OAuth `state` for the Intuit connect flow. Because
 * Intuit's redirect to /callback cannot carry the WorkOS bearer, we bind the
 * flow to a tenant here: /connect signs {tenantId, nonce}; /callback verifies
 * the signature + expiry to recover a TRUSTED tenantId (no server-side session).
 */
export interface StatePayload {
  tenantId: string;
  nonce: string;
}

interface SignedBody extends StatePayload {
  iat: number;
  exp: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function signState(
  payload: StatePayload,
  secret: string,
  opts: { now: number; ttlMs?: number },
): string {
  const body: SignedBody = {
    ...payload,
    iat: opts.now,
    exp: opts.now + (opts.ttlMs ?? DEFAULT_TTL_MS),
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyState(state: string, secret: string, opts: { now: number }): StatePayload {
  const parts = state.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed state.");
  }
  const [encoded, sig] = parts;

  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("Invalid state signature.");
  }

  const body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedBody;
  if (typeof body.exp !== "number" || body.exp < opts.now) {
    throw new Error("State expired.");
  }
  return { tenantId: body.tenantId, nonce: body.nonce };
}
