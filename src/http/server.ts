import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DomainError } from "../domain/errors.js";
import type { AuthorizationInput, CardStatus, Channel, Currency, ThreeDs } from "../domain/types.js";
import type { CardService } from "../ledger/service.js";
import { verifyWebhook } from "../webhooks/signature.js";

const CARD_STATUSES = new Set<CardStatus>(["inactive", "active", "frozen", "lost", "stolen", "terminated"]);
const CHANNELS = new Set<Channel>(["POS", "ECOMMERCE", "ATM"]);
const THREE_DS = new Set<ThreeDs>(["none", "frictionless", "challenge_passed", "challenge_failed"]);

export function createServer(service: CardService, webhookSecret: string): Server {
  return createHttpServer((req, res) => {
    void handle(service, webhookSecret, req, res);
  });
}

async function handle(service: CardService, webhookSecret: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = header(req, "x-request-id") ?? randomUUID();
  res.setHeader("x-request-id", requestId);
  res.setHeader("content-type", "application/json");

  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? "" : await readBody(req);

    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/cardholders") {
      const payload = object(parseJson(body));
      send(res, 201, service.createCardholder(requiredString(payload, "name")));
      return;
    }

    if (method === "POST" && url.pathname === "/v1/cards") {
      const payload = object(parseJson(body));
      const currency = requiredString(payload, "currency");
      if (currency !== "USD" && currency !== "HKD") {
        throw new DomainError("validation", "currency must be USD or HKD");
      }
      send(res, 201, service.issueCard(requiredString(payload, "cardholderId"), currency as Currency));
      return;
    }

    const cardAction = url.pathname.match(/^\/v1\/cards\/([^/]+)(?:\/(funding|status|ledger|spend-controls))?$/);
    if (cardAction) {
      const cardId = decodeURIComponent(cardAction[1] ?? "");
      const action = cardAction[2];
      if (!action && method === "GET") {
        send(res, 200, service.getCard(cardId));
        return;
      }
      if (action === "ledger" && method === "GET") {
        send(res, 200, { entries: service.ledger(cardId) });
        return;
      }
      if (action === "funding" && method === "POST") {
        const payload = object(parseJson(body));
        send(res, 200, service.fund(cardId, requiredString(payload, "eventId"), requiredMinor(payload, "amountMinor")));
        return;
      }
      if (action === "status" && method === "POST") {
        const payload = object(parseJson(body));
        const status = requiredString(payload, "status");
        if (!CARD_STATUSES.has(status as CardStatus)) throw new DomainError("validation", "unknown card status");
        send(res, 200, service.setStatus(cardId, status as CardStatus));
        return;
      }
      if (action === "spend-controls" && method === "PUT") {
        const payload = object(parseJson(body));
        send(res, 200, service.setSpendControls(cardId, {
          transactionLimitMinor: optionalMinor(payload, "transactionLimitMinor"),
          dailyLimitMinor: optionalMinor(payload, "dailyLimitMinor"),
          blockedMccs: stringArray(payload, "blockedMccs"),
          blockedAtmCountries: stringArray(payload, "blockedAtmCountries"),
          atmAllowed: requiredBoolean(payload, "atmAllowed"),
        }));
        return;
      }
    }

    if (method === "POST" && url.pathname === "/v1/authorizations") {
      send(res, 200, service.authorize(authorizationInput(object(parseJson(body)))));
      return;
    }
    if (method === "POST" && url.pathname === "/v1/clearing") {
      const payload = object(parseJson(body));
      send(res, 200, service.clear(
        requiredString(payload, "eventId"),
        requiredString(payload, "authorizationId"),
        nonNegativeMinor(payload, "clearedAmountMinor"),
      ));
      return;
    }
    if (method === "POST" && url.pathname === "/v1/reversals") {
      const payload = object(parseJson(body));
      send(res, 200, service.reverse(requiredString(payload, "eventId"), requiredString(payload, "authorizationId")));
      return;
    }
    if (method === "POST" && url.pathname === "/v1/refunds") {
      const payload = object(parseJson(body));
      send(res, 200, service.refund(
        requiredString(payload, "eventId"),
        requiredString(payload, "authorizationId"),
        requiredMinor(payload, "amountMinor"),
      ));
      return;
    }
    if (method === "POST" && url.pathname === "/v1/direct-clearing") {
      const payload = object(parseJson(body));
      send(res, 200, service.directClear(
        requiredString(payload, "eventId"),
        requiredString(payload, "cardId"),
        requiredMinor(payload, "amountMinor"),
        mcc(payload),
      ));
      return;
    }
    if (method === "POST" && url.pathname === "/v1/advice") {
      const payload = object(parseJson(body));
      send(res, 200, service.adviseTimeout(requiredString(payload, "eventId"), requiredString(payload, "authorizationId")));
      return;
    }
    if (method === "GET" && url.pathname === "/v1/outbox") {
      send(res, 200, { events: service.pendingOutbox() });
      return;
    }
    if (method === "POST" && url.pathname === "/webhooks/network") {
      const verified = verifyWebhook(body, header(req, "x-cardlane-signature"), webhookSecret);
      const payload = object(verified);
      if (requiredString(payload, "type") !== "authorization.requested") {
        throw new DomainError("validation", "unsupported webhook type");
      }
      send(res, 200, service.authorize(authorizationInput(object(payload.data))));
      return;
    }

    send(res, 404, { error: { code: "not_found", message: "route not found" } });
  } catch (error) {
    if (error instanceof DomainError) {
      const status = error.code === "validation" ? 400 : error.code === "unauthorized" ? 401 : error.code === "not_found" ? 404 : 409;
      send(res, status, { error: { code: error.code, message: error.message } });
      return;
    }
    console.error(error);
    send(res, 500, { error: { code: "internal", message: "internal error" } });
  }
}

function authorizationInput(payload: Record<string, unknown>): AuthorizationInput {
  const channel = requiredString(payload, "channel");
  const threeDs = requiredString(payload, "threeDs");
  if (!CHANNELS.has(channel as Channel)) throw new DomainError("validation", "channel must be POS, ECOMMERCE, or ATM");
  if (!THREE_DS.has(threeDs as ThreeDs)) throw new DomainError("validation", "threeDs value is invalid");
  const country = requiredString(payload, "merchantCountry");
  if (!/^[A-Z]{2}$/.test(country)) throw new DomainError("validation", "merchantCountry must be an ISO alpha-2 code");
  return {
    authorizationId: requiredString(payload, "authorizationId"),
    cardId: requiredString(payload, "cardId"),
    billAmountMinor: requiredMinor(payload, "billAmountMinor"),
    mcc: mcc(payload),
    channel: channel as Channel,
    merchantCountry: country,
    threeDs: threeDs as ThreeDs,
  };
}

function mcc(payload: Record<string, unknown>): string {
  const value = requiredString(payload, "mcc");
  if (!/^\d{4}$/.test(value)) throw new DomainError("validation", "mcc must be 4 digits");
  return value;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new DomainError("validation", "body must be JSON");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("validation", "body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("validation", `${key} is required`);
  }
  return value.trim();
}

function requiredMinor(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new DomainError("validation", `${key} must be a positive integer minor unit`);
  }
  return value;
}

function nonNegativeMinor(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DomainError("validation", `${key} must be a non-negative integer minor unit`);
  }
  return value;
}

function optionalMinor(payload: Record<string, unknown>, key: string): number | null {
  if (!(key in payload) || payload[key] === null) return null;
  return requiredMinor(payload, key);
}

function requiredBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== "boolean") throw new DomainError("validation", `${key} must be a boolean`);
  return value;
}

function stringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DomainError("validation", `${key} must be an array of strings`);
  }
  return value;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new DomainError("validation", "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}
