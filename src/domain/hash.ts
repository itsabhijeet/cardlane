import { createHash } from "node:crypto";

export function requestHash(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
