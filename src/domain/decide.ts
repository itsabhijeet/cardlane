import { ResponseCode, type CardStatus, type Channel, type ThreeDs } from "./types.js";

export const VELOCITY_WINDOW_MS = 60_000;
export const VELOCITY_MAX_AUTHS = 5;
export const ATM_DAILY_COUNT_LIMIT = 3;

export interface DecisionCard {
  status: CardStatus;
  transactionLimitMinor: number | null;
  dailyLimitMinor: number | null;
  blockedMccs: readonly string[];
  blockedAtmCountries: readonly string[];
  atmAllowed: boolean;
}

export interface DecisionInput {
  card: DecisionCard | null;
  amountMinor: number;
  mcc: string;
  channel: Channel;
  merchantCountry: string;
  threeDs: ThreeDs;
  availableMinor: number;
  dailySpendMinor: number;
  recentAuthCount: number;
  atmCountToday: number;
}

/**
 * Check order is the product contract. An earlier decline wins, so a stolen
 * card is reported as stolen rather than as insufficient funds.
 * The balance check is a fast no. The ledger update is the real guard.
 */
export function decide(input: DecisionInput): ResponseCode {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    return ResponseCode.NotPermitted;
  }

  const card = input.card;
  if (!card || card.status === "inactive" || card.status === "frozen" || card.status === "terminated") {
    return ResponseCode.Inactive;
  }
  if (card.status === "lost") return ResponseCode.Lost;
  if (card.status === "stolen") return ResponseCode.Stolen;

  if (input.channel === "ECOMMERCE" && input.threeDs !== "frictionless" && input.threeDs !== "challenge_passed") {
    return ResponseCode.NotPermitted;
  }
  if (card.blockedMccs.includes(input.mcc)) return ResponseCode.NotPermitted;
  if (input.recentAuthCount >= VELOCITY_MAX_AUTHS) return ResponseCode.SuspectedFraud;

  if (input.channel === "ATM" && (!card.atmAllowed || card.blockedAtmCountries.includes(input.merchantCountry))) {
    return ResponseCode.AtmNotAllowed;
  }
  if (input.channel === "ATM" && input.atmCountToday >= ATM_DAILY_COUNT_LIMIT) {
    return ResponseCode.AtmCountLimit;
  }

  if (card.transactionLimitMinor !== null && input.amountMinor > card.transactionLimitMinor) {
    return input.channel === "ATM" ? ResponseCode.AtmAmountLimit : ResponseCode.NotPermitted;
  }
  if (card.dailyLimitMinor !== null && input.dailySpendMinor + input.amountMinor > card.dailyLimitMinor) {
    return input.channel === "ATM" ? ResponseCode.AtmAmountLimit : ResponseCode.NotPermitted;
  }
  if (input.availableMinor < input.amountMinor) return ResponseCode.InsufficientFunds;
  return ResponseCode.Approved;
}
