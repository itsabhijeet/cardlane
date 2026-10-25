import { describe, expect, it } from "vitest";
import { ATM_DAILY_COUNT_LIMIT, decide, VELOCITY_MAX_AUTHS, type DecisionCard } from "../src/domain/decide.js";
import { ResponseCode } from "../src/domain/types.js";

function card(overrides: Partial<DecisionCard> = {}): DecisionCard {
  return {
    status: "active",
    transactionLimitMinor: null,
    dailyLimitMinor: null,
    blockedMccs: [],
    blockedAtmCountries: [],
    atmAllowed: true,
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof decide>[0]> = {}) {
  return {
    card: card(),
    amountMinor: 1_000,
    mcc: "5734",
    channel: "POS" as const,
    merchantCountry: "HK",
    threeDs: "none" as const,
    availableMinor: 5_000,
    dailySpendMinor: 0,
    recentAuthCount: 0,
    atmCountToday: 0,
    ...overrides,
  };
}

describe("decide", () => {
  it("approves a presentment the balance can cover", () => {
    expect(decide(input())).toBe(ResponseCode.Approved);
  });

  it("approves when available equals the amount", () => {
    expect(decide(input({ amountMinor: 5_000, availableMinor: 5_000 }))).toBe(ResponseCode.Approved);
  });

  it("declines a missing, frozen, or inactive card before it looks at funds", () => {
    expect(decide(input({ card: null, availableMinor: 0 }))).toBe(ResponseCode.Inactive);
    expect(decide(input({ card: card({ status: "frozen" }) }))).toBe(ResponseCode.Inactive);
    expect(decide(input({ card: card({ status: "lost" }) }))).toBe(ResponseCode.Lost);
    expect(decide(input({ card: card({ status: "stolen" }) }))).toBe(ResponseCode.Stolen);
  });

  it("requires 3DS on ecommerce and ignores it at a terminal", () => {
    expect(decide(input({ channel: "ECOMMERCE", threeDs: "none" }))).toBe(ResponseCode.NotPermitted);
    expect(decide(input({ channel: "ECOMMERCE", threeDs: "challenge_failed" }))).toBe(ResponseCode.NotPermitted);
    expect(decide(input({ channel: "ECOMMERCE", threeDs: "frictionless" }))).toBe(ResponseCode.Approved);
    expect(decide(input({ channel: "ECOMMERCE", threeDs: "challenge_passed" }))).toBe(ResponseCode.Approved);
  });

  it("blocks a merchant category, then velocity, then balance", () => {
    expect(decide(input({ mcc: "7995", card: card({ blockedMccs: ["7995"] }), availableMinor: 0 }))).toBe(
      ResponseCode.NotPermitted,
    );
    expect(decide(input({ recentAuthCount: VELOCITY_MAX_AUTHS }))).toBe(ResponseCode.SuspectedFraud);
    expect(decide(input({ availableMinor: 999 }))).toBe(ResponseCode.InsufficientFunds);
  });

  it("applies ATM country, count, and amount limits", () => {
    expect(decide(input({ channel: "ATM", card: card({ atmAllowed: false }) }))).toBe(ResponseCode.AtmNotAllowed);
    expect(decide(input({ channel: "ATM", card: card({ blockedAtmCountries: ["US"] }), merchantCountry: "US" }))).toBe(
      ResponseCode.AtmNotAllowed,
    );
    expect(decide(input({ channel: "ATM", atmCountToday: ATM_DAILY_COUNT_LIMIT }))).toBe(ResponseCode.AtmCountLimit);
    expect(decide(input({ channel: "ATM", amountMinor: 300, card: card({ transactionLimitMinor: 200 }) }))).toBe(
      ResponseCode.AtmAmountLimit,
    );
  });
});
