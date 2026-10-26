export class ResponseCache {
  #entries = new Map();
  #maxEntries;

  constructor(maxEntries) { this.#maxEntries = maxEntries; }

  get(key, now = Date.now()) {
    const entry = this.#entries.get(key);
    if (!entry) return { state: 'MISS' };
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (now < entry.expiresAt) return { state: 'HIT', entry };
    if (now < entry.staleUntil) return { state: 'STALE', entry };
    if (now < entry.errorStaleUntil) return { state: 'ERROR_STALE', entry };
    this.#entries.delete(key);
    return { state: 'MISS' };
  }

  set(key, entry) {
    if (this.#maxEntries === 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
  }

  deleteWhere(predicate) {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (predicate(entry, key)) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() { return this.#entries.size; }
}
