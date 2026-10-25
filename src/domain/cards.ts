import { DomainError } from "./errors.js";
import type { CardStatus } from "./types.js";

const transitions: Record<CardStatus, readonly CardStatus[]> = {
  inactive: ["active", "terminated"],
  active: ["frozen", "lost", "stolen", "terminated"],
  frozen: ["active", "lost", "stolen", "terminated"],
  lost: [],
  stolen: [],
  terminated: [],
};

export function assertTransition(from: CardStatus, to: CardStatus): void {
  if (!transitions[from].includes(to)) {
    throw new DomainError("conflict", `cannot move a card from ${from} to ${to}`);
  }
}

export function assertClientEventId(eventId: string): void {
  if (eventId.trim() === "" || eventId.startsWith("internal:")) {
    throw new DomainError("validation", "eventId must be a client-generated id");
  }
}
