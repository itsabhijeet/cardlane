import { describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/errors.js";
import { signWebhook, verifyWebhook } from "../src/webhooks/signature.js";

const secret = "test-secret";
const body = JSON.stringify({ id: "evt_1", amount: 10 });

describe("webhook signature", () => {
  it("accepts a fresh signature over the raw body", () => {
    const now = 1_700_000_000;
    const header = signWebhook(body, secret, now);
    expect(verifyWebhook(body, header, secret, now)).toEqual({ id: "evt_1", amount: 10 });
  });

  it("rejects a tampered body and a stale timestamp", () => {
    const now = 1_700_000_000;
    const header = signWebhook(body, secret, now);
    expect(() => verifyWebhook(body.replace("10", "11"), header, secret, now)).toThrow(DomainError);
    expect(() => verifyWebhook(body, header, secret, now + 301)).toThrow(/tolerance/);
  });
});
