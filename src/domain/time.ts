export function isoNow(now = new Date()): string {
  return now.toISOString();
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
