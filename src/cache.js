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
    this.#entries.delete(key);
    return { state: 'MISS' };
  }

  set(key, entry) {
    if (this.#maxEntries === 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
  }

  get size() { return this.#entries.size; }
}
