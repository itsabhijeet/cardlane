# Cardlane

A small card-issuing ledger you can run, test, and walk through in an interview.

Cardlane is an independent study project. It is not affiliated with Reap, Visa, or any card network. It does not store a real PAN, connect to a scheme, or move money. Amounts are integer minor units (cents).

It models the lifecycle published by card-issuing APIs:

1. Authorization places a **hold**. The cardholder can take the goods. Money has not settled.
2. Clearing captures the final amount. It may be lower (partial) or higher (overclear, common for hotels and fuel).
3. Reversal voids an open hold.
4. Refund returns settled funds.
5. Direct clearing has no prior approval. It is posted anyway, even if available goes negative.
6. A timeout advice means the network already declined. If you had approved locally, release the hold. If clearing already happened, do not undo it.

## Run it

Requires Node.js 22.5 or newer.

```bash
npm install
npm test
npm run demo
npm run dev
```

`npm run demo` prints one lifecycle with the balances after each step. The HTTP server listens on `http://localhost:3000`.

```bash
curl -s localhost:3000/health
```

Set `PORT`, `DATABASE_PATH`, and `WEBHOOK_SECRET` before using it for anything other than local study. The default secret is `dev-only-change-me`.

## What to open in a recruiter conversation

Spend five minutes on three files, in this order.

1. `src/domain/decide.ts` — the decline order. A lost card returns `41` before anyone mentions the balance. Ecommerce without 3DS returns `5C`. The balance check is only the last no.
2. `src/ledger/service.ts`, the `move` method — one `UPDATE` that reserves funds only when `available_minor + delta >= 0`. A second request with the same `authorizationId` returns the original decision and does not reserve again. A different body with that id is a conflict.
3. `test/ledger.test.ts` — partial clear, overclear, reversal, timeout advice after a local approval, and advice that arrives after clearing.

That is the whole system. The HTTP layer in `src/http/server.ts` parses JSON and calls the same service.

## Balance walk-through

Start with available `10000`, held `0`, settled `0`.

| Step | Available | Held | Settled |
| --- | ---: | ---: | ---: |
| Approve 2500 | 7500 | 2500 | 0 |
| Same authorization id again | 7500 | 2500 | 0 |
| Clear 2000 | 8000 | 0 | 2000 |
| Refund 500 | 8500 | 0 | 1500 |
| Approve 1000, then timeout advice | 8500 | 0 | 1500 |

A second card approves `100` and clears `180`. Available falls by an extra `80`. That overclear is accepted. Declining it is not an option the merchant is still waiting on; the hold was already given.

Two open holds are independent. Clearing one does not release the other. The test `keeps a second hold beside the first` locks that in.

## Response codes

| Code | When |
| --- | --- |
| `00` | Approved, hold placed |
| `41` / `43` | Lost / stolen |
| `46` | Inactive, frozen, terminated, or unknown |
| `51` | Insufficient funds |
| `5C` | Not permitted: blocked MCC, missing 3DS, limits |
| `59` | Too many attempts in 60 seconds |
| `61` / `62` / `65` | ATM amount, country, or count |

## Webhooks

`src/webhooks/signature.ts` verifies HMAC-SHA256 over `{timestamp}.{rawBody}`, rejects timestamps older than five minutes, and compares the digest with `timingSafeEqual`. Re-serializing the JSON before verification would break the signature.

Outbound events are inserted in the **same transaction** as the balance change (an outbox). `deliverPending` retries until the receiver accepts the event, then stops. A crash after the commit and before delivery leaves the row pending, so the event is delivered at least once. Receivers dedupe on the event id.

## What a production issuer would add

- A scheme connection and a PAN vault. This service stores a random last4 only.
- Postgres instead of the built-in SQLite, with the same conditional `UPDATE` and a unique key on `authorization_id`.
- A separate worker for the outbox. The API process only writes the row.
- FX, multi-clear messages, and a reconciliation job for holds that never clear and for local approvals later voided by advice.
- The synchronous authorization path stays free of slow calls. Fraud features that miss the time budget freeze the card for the **next** transaction.

SQLite's `BEGIN IMMEDIATE` makes the requests in this process serial. The `WHERE available_minor + ? >= 0` clause is what still holds when two app processes hit one database.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/cardholders` | Create a cardholder |
| `POST` | `/v1/cards` | Issue an inactive card |
| `POST` | `/v1/cards/:id/status` | Activate, freeze, or report lost/stolen |
| `POST` | `/v1/cards/:id/funding` | Add available balance |
| `PUT` | `/v1/cards/:id/spend-controls` | Limits, MCC blocks, ATM rules |
| `POST` | `/v1/authorizations` | Approve or decline |
| `POST` | `/v1/clearing` | Capture, partial or over |
| `POST` | `/v1/reversals` | Void an open hold |
| `POST` | `/v1/refunds` | Return settled funds |
| `POST` | `/v1/direct-clearing` | Capture with no hold |
| `POST` | `/v1/advice` | Network timeout after a local approval |
| `POST` | `/webhooks/network` | Signed `authorization.requested` event |
| `GET` | `/v1/cards/:id/ledger` | Postings for one card |

Authorization body:

```json
{
  "authorizationId": "auth_1",
  "cardId": "card_...",
  "billAmountMinor": 2500,
  "mcc": "5734",
  "channel": "ECOMMERCE",
  "merchantCountry": "HK",
  "threeDs": "frictionless"
}
```

Sign a webhook with `signWebhook` from `src/webhooks/signature.ts` and send the header `x-cardlane-signature`.
