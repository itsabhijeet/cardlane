export const ResponseCode = {
  Approved: "00",
  Lost: "41",
  Stolen: "43",
  Inactive: "46",
  InsufficientFunds: "51",
  NotPermitted: "5C",
  SuspectedFraud: "59",
  AtmAmountLimit: "61",
  AtmNotAllowed: "62",
  AtmCountLimit: "65",
} as const;

export type ResponseCode = (typeof ResponseCode)[keyof typeof ResponseCode];

export type CardStatus = "inactive" | "active" | "frozen" | "lost" | "stolen" | "terminated";

export type Channel = "POS" | "ECOMMERCE" | "ATM";

export type ThreeDs = "none" | "frictionless" | "challenge_passed" | "challenge_failed";

export type Currency = "USD" | "HKD";

export interface CardView {
  id: string;
  cardholderId: string;
  status: CardStatus;
  last4: string;
  currency: Currency;
  availableMinor: number;
  heldMinor: number;
  settledMinor: number;
  transactionLimitMinor: number | null;
  dailyLimitMinor: number | null;
  blockedMccs: string[];
  blockedAtmCountries: string[];
  atmAllowed: boolean;
}

export interface AuthorizationInput {
  authorizationId: string;
  cardId: string;
  billAmountMinor: number;
  mcc: string;
  channel: Channel;
  merchantCountry: string;
  threeDs: ThreeDs;
}

export interface AuthorizationResult {
  authorizationId: string;
  responseCode: ResponseCode;
  approved: boolean;
  replayed: boolean;
  availableMinor: number;
  heldMinor: number;
  settledMinor: number;
}

export interface PostingResult {
  eventId: string;
  authorizationId: string | null;
  action: string;
  replayed: boolean;
  creditRisk: boolean;
  availableMinor: number;
  heldMinor: number;
  settledMinor: number;
}

export interface LedgerEntryView {
  id: string;
  eventId: string;
  authorizationId: string | null;
  kind: string;
  availableDelta: number;
  heldDelta: number;
  settledDelta: number;
  createdAt: string;
}

export interface OutboxEvent {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  createdAt: string;
}
