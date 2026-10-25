import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertClientEventId, assertTransition } from "../domain/cards.js";
import { decide, VELOCITY_WINDOW_MS } from "../domain/decide.js";
import { DomainError } from "../domain/errors.js";
import { requestHash } from "../domain/hash.js";
import { isoNow, utcDay } from "../domain/time.js";
import {
  ResponseCode,
  type AuthorizationInput,
  type AuthorizationResult,
  type CardStatus,
  type CardView,
  type Currency,
  type LedgerEntryView,
  type OutboxEvent,
  type PostingResult,
} from "../domain/types.js";

interface AccountRow {
  available_minor: number;
  held_minor: number;
  settled_minor: number;
}

interface AuthRow {
  id: string;
  card_id: string | null;
  amount_minor: number;
  status: string;
  response_code: string;
  request_hash: string;
  response_json: string;
  cleared_minor: number;
  refunded_minor: number;
  created_at: string;
  channel: string;
}

interface CardRow {
  id: string;
  cardholder_id: string;
  status: CardStatus;
  last4: string;
  currency: Currency;
  transaction_limit_minor: number | null;
  daily_limit_minor: number | null;
  blocked_mccs: string;
  blocked_atm_countries: string;
  atm_allowed: number;
  available_minor: number;
  held_minor: number;
  settled_minor: number;
}

const MAX_MINOR = 1_000_000_000_00;

export class CardService {
  constructor(private readonly db: DatabaseSync) {}

  createCardholder(name: string): { id: string; name: string } {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      throw new DomainError("validation", "name is required");
    }
    const id = `holder_${randomUUID()}`;
    this.db.prepare("INSERT INTO cardholders (id, name, created_at) VALUES (?, ?, ?)").run(id, trimmed, isoNow());
    return { id, name: trimmed };
  }

  issueCard(cardholderId: string, currency: Currency): CardView {
    if (currency !== "USD" && currency !== "HKD") {
      throw new DomainError("validation", "currency must be USD or HKD");
    }
    const holder = this.db.prepare("SELECT id FROM cardholders WHERE id = ?").get(cardholderId);
    if (!holder) throw new DomainError("not_found", "cardholder not found");

    const id = `card_${randomUUID()}`;
    const last4 = String(randomInt(0, 10_000)).padStart(4, "0");
    const createdAt = isoNow();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO cards (
            id, cardholder_id, status, last4, currency, created_at
          ) VALUES (?, ?, 'inactive', ?, ?, ?)`,
        )
        .run(id, cardholderId, last4, currency, createdAt);
      this.db
        .prepare(
          `INSERT INTO accounts (card_id, available_minor, held_minor, settled_minor, version)
           VALUES (?, 0, 0, 0, 0)`,
        )
        .run(id);
    });
    return this.mustGetCard(id);
  }

  fund(cardId: string, eventId: string, amountMinor: number): PostingResult {
    assertClientEventId(eventId);
    assertPositive(amountMinor, "amountMinor");
    const hash = requestHash({ eventId, kind: "funding", cardId, amountMinor });
    return this.tx(() => {
      const replay = this.replayLedger(eventId, hash);
      if (replay) return replay;
      this.mustGetCard(cardId);
      this.move(cardId, amountMinor, 0, 0, false);
      return this.finishPosting({
        eventId,
        cardId,
        authorizationId: null,
        kind: "funding",
        hash,
        availableDelta: amountMinor,
        heldDelta: 0,
        settledDelta: 0,
        action: "funded",
      });
    });
  }

  setStatus(cardId: string, status: CardStatus): CardView {
    const current = this.mustGetCard(cardId);
    assertTransition(current.status, status);
    this.db.prepare("UPDATE cards SET status = ? WHERE id = ?").run(status, cardId);
    return this.mustGetCard(cardId);
  }

  setSpendControls(
    cardId: string,
    controls: {
      transactionLimitMinor: number | null;
      dailyLimitMinor: number | null;
      blockedMccs: string[];
      blockedAtmCountries: string[];
      atmAllowed: boolean;
    },
  ): CardView {
    this.mustGetCard(cardId);
    assertOptionalLimit(controls.transactionLimitMinor, "transactionLimitMinor");
    assertOptionalLimit(controls.dailyLimitMinor, "dailyLimitMinor");
    this.db
      .prepare(
        `UPDATE cards
         SET transaction_limit_minor = ?, daily_limit_minor = ?, blocked_mccs = ?,
             blocked_atm_countries = ?, atm_allowed = ?
         WHERE id = ?`,
      )
      .run(
        controls.transactionLimitMinor,
        controls.dailyLimitMinor,
        JSON.stringify(controls.blockedMccs),
        JSON.stringify(controls.blockedAtmCountries),
        controls.atmAllowed ? 1 : 0,
        cardId,
      );
    return this.mustGetCard(cardId);
  }

  getCard(cardId: string): CardView {
    return this.mustGetCard(cardId);
  }

  authorize(input: AuthorizationInput): AuthorizationResult {
    if (input.authorizationId.trim() === "" || input.cardId.trim() === "") {
      throw new DomainError("validation", "authorizationId and cardId are required");
    }
    const hash = requestHash({
      authorizationId: input.authorizationId,
      cardId: input.cardId,
      billAmountMinor: input.billAmountMinor,
      mcc: input.mcc,
      channel: input.channel,
      merchantCountry: input.merchantCountry,
      threeDs: input.threeDs,
    });

    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT request_hash, response_json FROM authorizations WHERE id = ?")
        .get(input.authorizationId) as { request_hash: string; response_json: string } | undefined;
      if (existing) {
        if (existing.request_hash !== hash) {
          throw new DomainError("conflict", "authorizationId reused with a different request");
        }
        return { ...(JSON.parse(existing.response_json) as AuthorizationResult), replayed: true };
      }

      const card = this.findCard(input.cardId);
      const now = new Date();
      const spend = card ? this.spend(card.id, utcDay(now)) : { amount_minor: 0, atm_count: 0 };
      const recentAuthCount = card ? this.recentCount(card.id, now) : 0;
      let responseCode = decide({
        card: card ? toDecisionCard(card) : null,
        amountMinor: input.billAmountMinor,
        mcc: input.mcc,
        channel: input.channel,
        merchantCountry: input.merchantCountry,
        threeDs: input.threeDs,
        availableMinor: card?.available_minor ?? 0,
        dailySpendMinor: spend.amount_minor,
        recentAuthCount,
        atmCountToday: spend.atm_count,
      });

      if (responseCode === ResponseCode.Approved && card) {
        const reserved = this.move(card.id, -input.billAmountMinor, input.billAmountMinor, 0, false);
        if (!reserved) responseCode = ResponseCode.InsufficientFunds;
      }

      const balances = card ? this.account(card.id) : zeroAccount();
      const result: AuthorizationResult = {
        authorizationId: input.authorizationId,
        responseCode,
        approved: responseCode === ResponseCode.Approved,
        replayed: false,
        availableMinor: balances.available_minor,
        heldMinor: balances.held_minor,
        settledMinor: balances.settled_minor,
      };

      this.db
        .prepare(
          `INSERT INTO authorizations (
            id, card_id, amount_minor, status, response_code, request_hash, response_json,
            mcc, channel, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.authorizationId,
          card?.id ?? null,
          input.billAmountMinor,
          result.approved ? "approved" : "declined",
          responseCode,
          hash,
          JSON.stringify(result),
          input.mcc,
          input.channel,
          isoNow(now),
        );

      if (result.approved && card) {
        this.insertLedger({
          eventId: `internal:hold:${input.authorizationId}`,
          cardId: card.id,
          authorizationId: input.authorizationId,
          kind: "authorization",
          hash,
          availableDelta: -input.billAmountMinor,
          heldDelta: input.billAmountMinor,
          settledDelta: 0,
          response: result,
        });
        this.db
          .prepare(
            `INSERT INTO spend_daily (card_id, day, amount_minor, atm_count)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (card_id, day) DO UPDATE SET
               amount_minor = amount_minor + excluded.amount_minor,
               atm_count = atm_count + excluded.atm_count`,
          )
          .run(card.id, utcDay(now), input.billAmountMinor, input.channel === "ATM" ? 1 : 0);
      }

      this.enqueue(result.approved ? "authorization.approved" : "authorization.declined", input.authorizationId, result);
      return result;
    });
  }

  clear(eventId: string, authorizationId: string, clearedAmountMinor: number): PostingResult {
    assertClientEventId(eventId);
    if (!Number.isInteger(clearedAmountMinor) || clearedAmountMinor < 0) {
      throw new DomainError("validation", "clearedAmountMinor must be a non-negative integer");
    }
    assertMax(clearedAmountMinor, "clearedAmountMinor");
    const hash = requestHash({ eventId, kind: "clearing", authorizationId, clearedAmountMinor });
    return this.tx(() => {
      const replay = this.replayLedger(eventId, hash);
      if (replay) return replay;
      const auth = this.mustAuth(authorizationId);
      if (auth.status !== "approved" || !auth.card_id) {
        throw new DomainError("conflict", "only an open approval can be cleared");
      }
      const remaining = auth.amount_minor - auth.cleared_minor;
      const unused = remaining - clearedAmountMinor;
      const availableDelta = unused;
      const heldDelta = -remaining;
      const settledDelta = clearedAmountMinor;
      const allowNegative = unused < 0;
      if (!this.move(auth.card_id, availableDelta, heldDelta, settledDelta, allowNegative)) {
        throw new DomainError("conflict", "hold could not be cleared");
      }
      this.db
        .prepare("UPDATE authorizations SET status = 'cleared', cleared_minor = ? WHERE id = ?")
        .run(clearedAmountMinor, authorizationId);
      return this.finishPosting({
        eventId,
        cardId: auth.card_id,
        authorizationId,
        kind: "clearing",
        hash,
        availableDelta,
        heldDelta,
        settledDelta,
        action: unused < 0 ? "overcleared" : "cleared",
      });
    });
  }

  reverse(eventId: string, authorizationId: string): PostingResult {
    assertClientEventId(eventId);
    const hash = requestHash({ eventId, kind: "reversal", authorizationId });
    return this.tx(() => {
      const replay = this.replayLedger(eventId, hash);
      if (replay) return replay;
      const auth = this.mustAuth(authorizationId);
      if (auth.status !== "approved" || !auth.card_id) {
        throw new DomainError("conflict", "only an open approval can be reversed");
      }
      if (!this.move(auth.card_id, auth.amount_minor, -auth.amount_minor, 0, false)) {
        throw new DomainError("conflict", "hold could not be reversed");
      }
      this.restoreSpend(auth);
      this.db.prepare("UPDATE authorizations SET status = 'reversed' WHERE id = ?").run(authorizationId);
      return this.finishPosting({
        eventId,
        cardId: auth.card_id,
        authorizationId,
        kind: "reversal",
        hash,
        availableDelta: auth.amount_minor,
        heldDelta: -auth.amount_minor,
        settledDelta: 0,
        action: "reversed",
      });
    });
  }

  refund(eventId: string, authorizationId: string, amountMinor: number): PostingResult {
    assertClientEventId(eventId);
    assertPositive(amountMinor, "amountMinor");
    const hash = requestHash({ eventId, kind: "refund", authorizationId, amountMinor });
    return this.tx(() => {
      const replay = this.replayLedger(eventId, hash);
      if (replay) return replay;
      const auth = this.mustAuth(authorizationId);
      if ((auth.status !== "cleared" && auth.status !== "refunded") || !auth.card_id) {
        throw new DomainError("conflict", "only a cleared authorization can be refunded");
      }
      if (auth.refunded_minor + amountMinor > auth.cleared_minor) {
        throw new DomainError("validation", "refund exceeds the cleared amount");
      }
      if (!this.move(auth.card_id, amountMinor, 0, -amountMinor, false)) {
        throw new DomainError("conflict", "refund could not be posted");
      }
      const refunded = auth.refunded_minor + amountMinor;
      const status = refunded === auth.cleared_minor ? "refunded" : "cleared";
      this.db
        .prepare("UPDATE authorizations SET refunded_minor = ?, status = ? WHERE id = ?")
        .run(refunded, status, authorizationId);
      return this.finishPosting({
        eventId,
        cardId: auth.card_id,
        authorizationId,
        kind: "refund",
        hash,
        availableDelta: amountMinor,
        heldDelta: 0,
        settledDelta: -amountMinor,
        action: "refunded",
      });
    });
  }

  directClear(eventId: string, cardId: string, amountMinor: number, mcc: string): PostingResult {
    assertClientEventId(eventId);
    assertPositive(amountMinor, "amountMinor");
    const hash = requestHash({ eventId, kind: "direct_clearing", cardId, amountMinor, mcc });
    return this.tx(() => {
      const replay = this.replayLedger(eventId, hash);
      if (replay) return replay;
      this.mustGetCard(cardId);
      if (!this.move(cardId, -amountMinor, 0, amountMinor, true)) {
        throw new DomainError("conflict", "direct clearing could not be posted");
      }
      return this.finishPosting({
        eventId,
        cardId,
        authorizationId: null,
        kind: "direct_clearing",
        hash,
        availableDelta: -amountMinor,
        heldDelta: 0,
        settledDelta: amountMinor,
        action: "direct_cleared",
      });
    });
  }

  adviseTimeout(eventId: string, authorizationId: string): PostingResult {
    assertClientEventId(eventId);
    const hash = requestHash({ eventId, kind: "timeout_advice", authorizationId });
    return this.tx(() => {
      const replay = this.replayLedger(eventId, hash);
      if (replay) return replay;
      const auth = this.mustAuth(authorizationId);
      if (!auth.card_id) throw new DomainError("conflict", "authorization has no card");

      if (auth.status === "approved") {
        if (!this.move(auth.card_id, auth.amount_minor, -auth.amount_minor, 0, false)) {
          throw new DomainError("conflict", "hold could not be released");
        }
        this.restoreSpend(auth);
        this.db.prepare("UPDATE authorizations SET status = 'timeout_declined' WHERE id = ?").run(authorizationId);
        return this.finishPosting({
          eventId,
          cardId: auth.card_id,
          authorizationId,
          kind: "timeout_advice",
          hash,
          availableDelta: auth.amount_minor,
          heldDelta: -auth.amount_minor,
          settledDelta: 0,
          action: "released_hold",
        });
      }

      return this.finishPosting({
        eventId,
        cardId: auth.card_id,
        authorizationId,
        kind: "timeout_advice",
        hash,
        availableDelta: 0,
        heldDelta: 0,
        settledDelta: 0,
        action: auth.status === "cleared" || auth.status === "refunded" ? "already_settled" : "already_undone",
      });
    });
  }

  ledger(cardId: string): LedgerEntryView[] {
    this.mustGetCard(cardId);
    const rows = this.db
      .prepare(
        `SELECT id, event_id, authorization_id, kind, available_delta, held_delta, settled_delta, created_at
         FROM ledger_entries WHERE card_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(cardId) as Array<{
      id: string;
      event_id: string;
      authorization_id: string | null;
      kind: string;
      available_delta: number;
      held_delta: number;
      settled_delta: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      authorizationId: row.authorization_id,
      kind: row.kind,
      availableDelta: row.available_delta,
      heldDelta: row.held_delta,
      settledDelta: row.settled_delta,
      createdAt: row.created_at,
    }));
  }

  pendingOutbox(): OutboxEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, payload, status, attempts, created_at
         FROM outbox WHERE status = 'pending' ORDER BY created_at ASC`,
      )
      .all() as Array<{
      id: string;
      type: string;
      payload: string;
      status: string;
      attempts: number;
      created_at: string;
    }>;
    return rows.map(toOutbox);
  }

  deliverPending(sender: (event: OutboxEvent) => boolean): number {
    let delivered = 0;
    for (const event of this.pendingOutbox()) {
      this.db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(event.id);
      if (!sender(event)) continue;
      this.db.prepare("UPDATE outbox SET status = 'delivered' WHERE id = ?").run(event.id);
      delivered += 1;
    }
    return delivered;
  }

  private finishPosting(input: {
    eventId: string;
    cardId: string;
    authorizationId: string | null;
    kind: string;
    hash: string;
    availableDelta: number;
    heldDelta: number;
    settledDelta: number;
    action: string;
  }): PostingResult {
    const balances = this.account(input.cardId);
    const result: PostingResult = {
      eventId: input.eventId,
      authorizationId: input.authorizationId,
      action: input.action,
      replayed: false,
      creditRisk: balances.available_minor < 0,
      availableMinor: balances.available_minor,
      heldMinor: balances.held_minor,
      settledMinor: balances.settled_minor,
    };
    this.insertLedger({
      eventId: input.eventId,
      cardId: input.cardId,
      authorizationId: input.authorizationId,
      kind: input.kind,
      hash: input.hash,
      availableDelta: input.availableDelta,
      heldDelta: input.heldDelta,
      settledDelta: input.settledDelta,
      response: result,
    });
    this.enqueue(input.kind, input.eventId, result);
    return result;
  }

  private replayLedger(eventId: string, hash: string): PostingResult | undefined {
    const existing = this.db
      .prepare("SELECT request_hash, response_json FROM ledger_entries WHERE event_id = ?")
      .get(eventId) as { request_hash: string; response_json: string } | undefined;
    if (!existing) return undefined;
    if (existing.request_hash !== hash) {
      throw new DomainError("conflict", "eventId reused with a different request");
    }
    return { ...(JSON.parse(existing.response_json) as PostingResult), replayed: true };
  }

  private insertLedger(input: {
    eventId: string;
    cardId: string;
    authorizationId: string | null;
    kind: string;
    hash: string;
    availableDelta: number;
    heldDelta: number;
    settledDelta: number;
    response: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ledger_entries (
          id, event_id, card_id, authorization_id, kind, request_hash,
          available_delta, held_delta, settled_delta, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `led_${randomUUID()}`,
        input.eventId,
        input.cardId,
        input.authorizationId,
        input.kind,
        input.hash,
        input.availableDelta,
        input.heldDelta,
        input.settledDelta,
        JSON.stringify(input.response),
        isoNow(),
      );
  }

  private enqueue(type: string, id: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO outbox (id, type, payload, status, attempts, created_at) VALUES (?, ?, ?, 'pending', 0, ?)")
      .run(`${type}:${id}`, type, JSON.stringify(payload), isoNow());
  }

  private move(
    cardId: string,
    availableDelta: number,
    heldDelta: number,
    settledDelta: number,
    allowNegativeAvailable: boolean,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE accounts
         SET available_minor = available_minor + ?,
             held_minor = held_minor + ?,
             settled_minor = settled_minor + ?,
             version = version + 1
         WHERE card_id = ?
           AND (? = 1 OR available_minor + ? >= 0)
           AND held_minor + ? >= 0
           AND settled_minor + ? >= 0`,
      )
      .run(
        availableDelta,
        heldDelta,
        settledDelta,
        cardId,
        allowNegativeAvailable ? 1 : 0,
        availableDelta,
        heldDelta,
        settledDelta,
      );
    return result.changes === 1;
  }

  private restoreSpend(auth: AuthRow): void {
    if (!auth.card_id) return;
    const day = utcDay(new Date(auth.created_at));
    this.db
      .prepare(
        `UPDATE spend_daily
         SET amount_minor = MAX(0, amount_minor - ?),
             atm_count = MAX(0, atm_count - ?)
         WHERE card_id = ? AND day = ?`,
      )
      .run(auth.amount_minor, auth.channel === "ATM" ? 1 : 0, auth.card_id, day);
  }

  private spend(cardId: string, day: string): { amount_minor: number; atm_count: number } {
    return (
      (this.db
        .prepare("SELECT amount_minor, atm_count FROM spend_daily WHERE card_id = ? AND day = ?")
        .get(cardId, day) as { amount_minor: number; atm_count: number } | undefined) ?? {
        amount_minor: 0,
        atm_count: 0,
      }
    );
  }

  private recentCount(cardId: string, now: Date): number {
    const since = new Date(now.getTime() - VELOCITY_WINDOW_MS).toISOString();
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM authorizations WHERE card_id = ? AND created_at >= ?")
      .get(cardId, since) as { n: number };
    return row.n;
  }

  private mustAuth(id: string): AuthRow {
    const row = this.db
      .prepare(
        `SELECT id, card_id, amount_minor, status, response_code, request_hash, response_json,
                cleared_minor, refunded_minor, created_at, channel
         FROM authorizations WHERE id = ?`,
      )
      .get(id) as AuthRow | undefined;
    if (!row) throw new DomainError("not_found", "authorization not found");
    return row;
  }

  private account(cardId: string): AccountRow {
    const row = this.db
      .prepare("SELECT available_minor, held_minor, settled_minor FROM accounts WHERE card_id = ?")
      .get(cardId) as AccountRow | undefined;
    if (!row) throw new DomainError("not_found", "account not found");
    return row;
  }

  private findCard(cardId: string): CardRow | undefined {
    return this.db
      .prepare(
        `SELECT c.id, c.cardholder_id, c.status, c.last4, c.currency,
                c.transaction_limit_minor, c.daily_limit_minor, c.blocked_mccs,
                c.blocked_atm_countries, c.atm_allowed,
                a.available_minor, a.held_minor, a.settled_minor
         FROM cards c JOIN accounts a ON a.card_id = c.id
         WHERE c.id = ?`,
      )
      .get(cardId) as CardRow | undefined;
  }

  private mustGetCard(cardId: string): CardView {
    const row = this.findCard(cardId);
    if (!row) throw new DomainError("not_found", "card not found");
    return toCardView(row);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function toDecisionCard(card: CardRow) {
  return {
    status: card.status,
    transactionLimitMinor: card.transaction_limit_minor,
    dailyLimitMinor: card.daily_limit_minor,
    blockedMccs: JSON.parse(card.blocked_mccs) as string[],
    blockedAtmCountries: JSON.parse(card.blocked_atm_countries) as string[],
    atmAllowed: card.atm_allowed === 1,
  };
}

function toCardView(card: CardRow): CardView {
  return {
    id: card.id,
    cardholderId: card.cardholder_id,
    status: card.status,
    last4: card.last4,
    currency: card.currency,
    availableMinor: card.available_minor,
    heldMinor: card.held_minor,
    settledMinor: card.settled_minor,
    transactionLimitMinor: card.transaction_limit_minor,
    dailyLimitMinor: card.daily_limit_minor,
    blockedMccs: JSON.parse(card.blocked_mccs) as string[],
    blockedAtmCountries: JSON.parse(card.blocked_atm_countries) as string[],
    atmAllowed: card.atm_allowed === 1,
  };
}

function toOutbox(row: {
  id: string;
  type: string;
  payload: string;
  status: string;
  attempts: number;
  created_at: string;
}): OutboxEvent {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

function zeroAccount(): AccountRow {
  return { available_minor: 0, held_minor: 0, settled_minor: 0 };
}

function assertPositive(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DomainError("validation", `${label} must be a positive integer minor unit`);
  }
  assertMax(amount, label);
}

function assertOptionalLimit(amount: number | null, label: string): void {
  if (amount === null) return;
  assertPositive(amount, label);
}

function assertMax(amount: number, label: string): void {
  if (amount > MAX_MINOR) throw new DomainError("validation", `${label} exceeds the supported maximum`);
}
