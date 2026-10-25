import { openDatabase } from "../src/db/schema.js";
import { CardService } from "../src/ledger/service.js";
import type { AuthorizationInput, CardView } from "../src/domain/types.js";

export function service(): CardService {
  return new CardService(openDatabase(":memory:"));
}

export function fundedCard(cards: CardService, amountMinor = 10_000): CardView {
  const holder = cards.createCardholder("Ada Lovelace");
  const card = cards.issueCard(holder.id, "USD");
  cards.setStatus(card.id, "active");
  cards.fund(card.id, `fund_${card.id}`, amountMinor);
  return cards.getCard(card.id);
}

export function authInput(cardId: string, overrides: Partial<AuthorizationInput> = {}): AuthorizationInput {
  return {
    authorizationId: "auth_1",
    cardId,
    billAmountMinor: 2_500,
    mcc: "5734",
    channel: "POS",
    merchantCountry: "HK",
    threeDs: "none",
    ...overrides,
  };
}
