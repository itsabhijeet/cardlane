import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/schema.js";
import { CardService } from "../src/ledger/service.js";
import type { AuthorizationResult, CardView, PostingResult } from "../src/domain/types.js";

const dbPath = join(mkdtempSync(join(tmpdir(), "cardlane-")), "demo.db");
const cards = new CardService(openDatabase(dbPath));

const holder = cards.createCardholder("Ada Lovelace");
const card = cards.issueCard(holder.id, "USD");
step("issue an inactive card", cards.getCard(card.id));

const inactive = cards.authorize(request(card, "auth_inactive", 2_500));
expectCode(inactive, "46", "inactive card");

cards.setStatus(card.id, "active");
const funded = cards.fund(card.id, "fund_demo", 10_000);
expectMoney(funded, 10_000, 0, 0, "funding");

cards.setSpendControls(card.id, {
  transactionLimitMinor: 5_000,
  dailyLimitMinor: 8_000,
  blockedMccs: ["7995"],
  blockedAtmCountries: ["US"],
  atmAllowed: true,
});

const approved = cards.authorize(request(card, "auth_shop", 2_500, { channel: "ECOMMERCE", threeDs: "frictionless" }));
expectCode(approved, "00", "ecommerce with frictionless 3DS");
expectMoney(approved, 7_500, 2_500, 0, "hold placed");

const replay = cards.authorize(request(card, "auth_shop", 2_500, { channel: "ECOMMERCE", threeDs: "frictionless" }));
if (!replay.replayed) fail("replay should not reserve the funds again");
step("replay the same authorization", replay);

const blocked = cards.authorize(request(card, "auth_gambling", 100, { mcc: "7995" }));
expectCode(blocked, "5C", "blocked MCC");

const no3ds = cards.authorize(request(card, "auth_no3ds", 100, { channel: "ECOMMERCE", threeDs: "none" }));
expectCode(no3ds, "5C", "ecommerce without 3DS");

const cleared = cards.clear("clear_shop", "auth_shop", 2_000);
expectMoney(cleared, 8_000, 0, 2_000, "partial clear releases the unused 500");

const refunded = cards.refund("refund_shop", "auth_shop", 500);
expectMoney(refunded, 8_500, 0, 1_500, "partial refund");

const held = cards.authorize(request(card, "auth_timeout", 1_000));
expectCode(held, "00", "second approval");
const advice = cards.adviseTimeout("advice_timeout", "auth_timeout");
expectMoney(advice, 8_500, 0, 1_500, "timeout advice releases the hold");

const hotelCard = cards.issueCard(holder.id, "USD");
cards.setStatus(hotelCard.id, "active");
cards.fund(hotelCard.id, "fund_hotel", 10_000);
const hotel = cards.authorize(request(hotelCard, "auth_hotel", 100, { mcc: "7011" }));
expectCode(hotel, "00", "hotel auth on a second card");
const over = cards.clear("clear_hotel", "auth_hotel", 180);
expectMoney(over, 9_820, 0, 180, "hotel overclear of 80");

cards.setStatus(card.id, "lost");
const lost = cards.authorize(request(card, "auth_lost", 100));
expectCode(lost, "41", "lost card");

const delivered = cards.deliverPending((event) => {
  console.log(`  outbox ${event.type}`);
  return true;
});
step(`delivered ${delivered} outbox events`, { delivered });

console.log("\nDemo balances match the lifecycle. Open src/domain/decide.ts and src/ledger/service.ts next.");

function request(
  issued: CardView,
  authorizationId: string,
  billAmountMinor: number,
  overrides: Partial<Parameters<CardService["authorize"]>[0]> = {},
) {
  return {
    authorizationId,
    cardId: issued.id,
    billAmountMinor,
    mcc: "5734",
    channel: "POS" as const,
    merchantCountry: "HK",
    threeDs: "none" as const,
    ...overrides,
  };
}

function expectCode(result: AuthorizationResult, code: string, label: string): void {
  if (result.responseCode !== code) fail(`${label}: expected ${code}, got ${result.responseCode}`);
  step(label, result);
}

function expectMoney(
  result: AuthorizationResult | PostingResult,
  available: number,
  held: number,
  settled: number,
  label: string,
): void {
  if (result.availableMinor !== available || result.heldMinor !== held || result.settledMinor !== settled) {
    fail(`${label}: expected available ${available}, held ${held}, settled ${settled}; got ${JSON.stringify(result)}`);
  }
  step(label, result);
}

function step(label: string, detail: unknown): void {
  console.log(`\n${label}`);
  console.log(`  ${JSON.stringify(detail)}`);
}

function fail(message: string): never {
  throw new Error(message);
}
