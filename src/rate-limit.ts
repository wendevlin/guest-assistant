/**
 * Counts attempts per client address over a sliding minute, with a ceiling
 * for all addresses together, so many addresses (e.g. an IPv6 prefix) cannot
 * guess faster than one. Only admitted attempts are recorded, so the map
 * holds at most `total` entries.
 */
export class AttemptLimiter {
  private attempts = new Map<string, number[]>();

  constructor(
    private readonly perClient: number,
    private readonly total: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Drops old attempts and returns how many all clients made in the window. */
  private prune(now: number): number {
    let total = 0;
    for (const [client, times] of this.attempts) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length) this.attempts.set(client, recent);
      else this.attempts.delete(client);
      total += recent.length;
    }
    return total;
  }

  /** True if the next attempt of this client would be refused. Records nothing. */
  blocked(client: string): boolean {
    const total = this.prune(Date.now());
    return (this.attempts.get(client)?.length ?? 0) >= this.perClient || total >= this.total;
  }

  /** Records an attempt; false (and nothing recorded) if the client is over the limit. */
  take(client: string): boolean {
    const now = Date.now();
    const total = this.prune(now);
    const mine = this.attempts.get(client) ?? [];
    if (mine.length >= this.perClient || total >= this.total) return false;
    this.attempts.set(client, [...mine, now]);
    return true;
  }
}
