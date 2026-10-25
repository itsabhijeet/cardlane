import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/schema.js";
import { createServer } from "../src/http/server.js";
import { CardService } from "../src/ledger/service.js";
import { signWebhook } from "../src/webhooks/signature.js";

const secret = "test-secret";
let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

async function start(): Promise<CardService> {
  const service = new CardService(openDatabase(":memory:"));
  const server = createServer(service, secret);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  closeServer = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return service;
}

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("http", () => {
  it("funds a card and approves an authorization", async () => {
    await start();
    const holder = await post("/v1/cardholders", { name: "Katherine Johnson" });
    const card = await post("/v1/cards", { cardholderId: holder.id, currency: "USD" });
    await post(`/v1/cards/${card.id}/status`, { status: "active" });
    await post(`/v1/cards/${card.id}/funding`, { eventId: "fund_http", amountMinor: 5_000 });
    const decision = await post("/v1/authorizations", {
      authorizationId: "auth_http",
      cardId: card.id,
      billAmountMinor: 1_250,
      mcc: "5411",
      channel: "POS",
      merchantCountry: "HK",
      threeDs: "none",
    });
    expect(decision).toMatchObject({ responseCode: "00", availableMinor: 3_750, heldMinor: 1_250 });

    const replay = await post("/v1/authorizations", {
      authorizationId: "auth_http",
      cardId: card.id,
      billAmountMinor: 1_250,
      mcc: "5411",
      channel: "POS",
      merchantCountry: "HK",
      threeDs: "none",
    });
    expect(replay.replayed).toBe(true);
  });

  it("accepts a signed webhook and rejects a missing signature", async () => {
    await start();
    const holder = await post("/v1/cardholders", { name: "Mary Jackson" });
    const card = await post("/v1/cards", { cardholderId: holder.id, currency: "USD" });
    await post(`/v1/cards/${card.id}/status`, { status: "active" });
    await post(`/v1/cards/${card.id}/funding`, { eventId: "fund_hook", amountMinor: 2_000 });

    const raw = JSON.stringify({
      id: "evt_auth",
      type: "authorization.requested",
      data: {
        authorizationId: "auth_hook",
        cardId: card.id,
        billAmountMinor: 500,
        mcc: "5734",
        channel: "ECOMMERCE",
        merchantCountry: "GB",
        threeDs: "frictionless",
      },
    });
    const signed = await fetch(`${baseUrl}/webhooks/network`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cardlane-signature": signWebhook(raw, secret) },
      body: raw,
    });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ responseCode: "00", heldMinor: 500 });

    const unsigned = await fetch(`${baseUrl}/webhooks/network`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    expect(unsigned.status).toBe(401);
  });
});

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}
