import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/errors.js";

const TOLERANCE_SECONDS = 300;

export function signWebhook(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyWebhook(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): unknown {
  if (!header) throw new DomainError("unauthorized", "missing signature");

  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") timestamp = Number(value);
    if (key === "v1") signature = value;
  }

  if (timestamp === undefined || !Number.isFinite(timestamp) || !signature) {
    throw new DomainError("unauthorized", "invalid signature header");
  }
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) {
    throw new DomainError("unauthorized", "timestamp outside tolerance");
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
    throw new DomainError("unauthorized", "invalid signature");
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new DomainError("validation", "webhook body must be JSON");
  }
}
