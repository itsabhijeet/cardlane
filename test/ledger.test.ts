import { describe, expect, it } from "vitest";
import { VELOCITY_MAX_AUTHS } from "../src/domain/decide.js";
import { DomainError } from "../src/domain/errors.js";
import { ResponseCode } from "../src/domain/types.js";
import { authInput, fundedCard, service } from "./helpers.js";

describe("ledger", () => {
  it("reserves funds once for an authorization id", () => {
    const cards = service();
    const card = fundedCard(cards, 1_000);
    const first = cards.authorize(authInput(card.id, { billAmountMinor: 400 }));
    const second = cards.authorize(authInput(card.id, { billAmountMinor: 400 }));

    expect(first).toMatchObject({ responseCode: ResponseCode.Approved, replayed: false, availableMinor: 600, heldMinor: 400 });
    expect(second).toMatchObject({ responseCode: ResponseCode.Approved, replayed: true, availableMinor: 600, heldMinor: 400 });
    expect(cards.getCard(card.id)).toMatchObject({ availableMinor: 600, heldMinor: 400, settledMinor: 0 });
  });

  it("rejects the same authorization id when the body changes", () => {
    const cards = service();
    const card = fundedCard(cards, 1_000);
    cards.authorize(authInput(card.id, { billAmountMinor: 400 }));
    expect(() => cards.authorize(authInput(card.id, { billAmountMinor: 500 }))).toThrow(DomainError);
  });

  it("keeps a second hold beside the first", () => {
    const cards = service();
    const card = fundedCard(cards, 1_000);
    cards.authorize(authInput(card.id, { authorizationId: "auth_a", billAmountMinor: 100 }));
    cards.authorize(authInput(card.id, { authorizationId: "auth_b", billAmountMinor: 40 }));
    cards.clear("clear_a", "auth_a", 100);
    expect(cards.getCard(card.id)).toMatchObject({ availableMinor: 860, heldMinor: 40, settledMinor: 100 });
  });

  it("releases the unused hold when clearing is partial", () => {
    const cards = service();
    const card = fundedCard(cards, 1_000);
    cards.authorize(authInput(card.id, { billAmountMinor: 100 }));
    const cleared = cards.clear("clear_1", "auth_1", 80);
    expect(cleared).toMatchObject({ action: "cleared", availableMinor: 920, heldMinor: 0, settledMinor: 80, creditRisk: false });
    expect(cards.clear("clear_1", "auth_1", 80).replayed).toBe(true);
  });

  it("posts an overclear that drives available negative", () => {
    const cards = service();
    const card = fundedCard(cards, 100);
    cards.authorize(authInput(card.id, { billAmountMinor: 100 }));
    const cleared = cards.clear("clear_1", "auth_1", 150);
    expect(cleared).toMatchObject({ action: "overcleared", availableMinor: -50, heldMinor: 0, settledMinor: 150, creditRisk: true });
  });

  it("restores the hold on reversal and again on a timeout advice", () => {
    const cards = service();
    const card = fundedCard(cards, 1_000);
    cards.authorize(authInput(card.id, { authorizationId: "auth_rev", billAmountMinor: 250 }));
    expect(cards.reverse("rev_1", "auth_rev")).toMatchObject({ action: "reversed", availableMinor: 1_000, heldMinor: 0 });

    cards.authorize(authInput(card.id, { authorizationId: "auth_to", billAmountMinor: 250 }));
    expect(cards.adviseTimeout("adv_1", "auth_to")).toMatchObject({ action: "released_hold", availableMinor: 1_000, heldMinor: 0 });
    expect(cards.adviseTimeout("adv_1", "auth_to").replayed).toBe(true);
  });

  it("does not unsettle a clearing when a late timeout advice arrives", () => {
    const cards = service();
    const card = fundedCard(cards, 1_000);
    cards.authorize(authInput(card.id, { billAmountMinor: 100 }));
    cards.clear("clear_1", "auth_1", 100);
    const advice = cards.adviseTimeout("adv_late", "auth_1");
    expect(advice).toMatchObject({ action: "already_settled", availableMinor: 900, settledMinor: 100 });
  });

  it("refunds part of a cleared amount and refuses the rest", () => {
    const cards = service();
    const card = fundedCard(cards, 1_000);
    cards.authorize(authInput(card.id, { billAmountMinor: 200 }));
    cards.clear("clear_1", "auth_1", 200);
    expect(cards.refund("ref_1", "auth_1", 50)).toMatchObject({ action: "refunded", availableMinor: 850, settledMinor: 150 });
    expect(() => cards.refund("ref_2", "auth_1", 200)).toThrow(/exceeds the cleared amount/);
  });

  it("accepts a direct clearing with no prior hold", () => {
    const cards = service();
    const card = fundedCard(cards, 30);
    const posted = cards.directClear("direct_1", card.id, 80, "5541");
    expect(posted).toMatchObject({ action: "direct_cleared", availableMinor: -50, settledMinor: 80, creditRisk: true });
  });

  it("declines the authorization that would break a daily limit, then allows it after a reversal", () => {
    const cards = service();
    const card = fundedCard(cards, 10_000);
    cards.setSpendControls(card.id, {
      transactionLimitMinor: null,
      dailyLimitMinor: 1_000,
      blockedMccs: ["7995"],
      blockedAtmCountries: [],
      atmAllowed: true,
    });
    cards.authorize(authInput(card.id, { authorizationId: "auth_day", billAmountMinor: 800 }));
    const blocked = cards.authorize(authInput(card.id, { authorizationId: "auth_over", billAmountMinor: 300 }));
    expect(blocked.responseCode).toBe(ResponseCode.NotPermitted);
    cards.reverse("rev_day", "auth_day");
    expect(cards.authorize(authInput(card.id, { authorizationId: "auth_after", billAmountMinor: 300 })).responseCode).toBe(
      ResponseCode.Approved,
    );
    expect(cards.authorize(authInput(card.id, { authorizationId: "auth_mcc", mcc: "7995" })).responseCode).toBe(
      ResponseCode.NotPermitted,
    );
  });

  it("declines the attempt that crosses the velocity window", () => {
    const cards = service();
    const card = fundedCard(cards, 100_000);
    for (let i = 0; i < VELOCITY_MAX_AUTHS; i += 1) {
      expect(cards.authorize(authInput(card.id, { authorizationId: `auth_${i}`, billAmountMinor: 10 })).responseCode).toBe(
        ResponseCode.Approved,
      );
    }
    expect(cards.authorize(authInput(card.id, { authorizationId: "auth_fast", billAmountMinor: 10 })).responseCode).toBe(
      ResponseCode.SuspectedFraud,
    );
  });

  it("does not move money for an inactive card or a failed ecommerce challenge", () => {
    const cards = service();
    const holder = cards.createCardholder("Grace Hopper");
    const inactive = cards.issueCard(holder.id, "HKD");
    cards.fund(inactive.id, "fund_inactive", 5_000);
    expect(cards.authorize(authInput(inactive.id)).responseCode).toBe(ResponseCode.Inactive);
    cards.setStatus(inactive.id, "active");
    expect(
      cards.authorize(authInput(inactive.id, { authorizationId: "auth_ecom", channel: "ECOMMERCE", threeDs: "none" }))
        .responseCode,
    ).toBe(ResponseCode.NotPermitted);
    expect(cards.getCard(inactive.id).availableMinor).toBe(5_000);
  });

  it("retries an outbox event until the receiver accepts it", () => {
    const cards = service();
    const card = fundedCard(cards);
    cards.authorize(authInput(card.id));
    expect(cards.deliverPending(() => false)).toBe(0);
    expect(cards.pendingOutbox().length).toBeGreaterThan(0);
    const seen: string[] = [];
    expect(cards.deliverPending((event) => {
      seen.push(event.type);
      return true;
    })).toBeGreaterThan(0);
    expect(seen).toContain("authorization.approved");
    expect(cards.pendingOutbox()).toEqual([]);
    expect(cards.deliverPending(() => true)).toBe(0);
  });
});
