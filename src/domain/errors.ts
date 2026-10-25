export type ErrorCode = "validation" | "unauthorized" | "not_found" | "conflict";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
