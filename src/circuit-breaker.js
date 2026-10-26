export class CircuitOpenError extends Error {
  constructor(retryAfterSeconds) {
    super('The upstream circuit is temporarily open.');
    this.name = 'CircuitOpenError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class CircuitBreaker {
  #failureThreshold;
  #resetMs;
  #failures = 0;
  #openedAt = 0;

  constructor({ failureThreshold, resetSeconds }) {
    this.#failureThreshold = failureThreshold;
    this.#resetMs = resetSeconds * 1000;
  }

  assertAvailable(now = Date.now()) {
    if (this.#openedAt === 0) return;
    const elapsed = now - this.#openedAt;
    if (elapsed >= this.#resetMs) {
      this.#openedAt = 0;
      this.#failures = 0;
      return;
    }
    throw new CircuitOpenError(Math.ceil((this.#resetMs - elapsed) / 1000));
  }

  recordSuccess() { this.#failures = 0; this.#openedAt = 0; }

  recordFailure(now = Date.now()) {
    this.#failures += 1;
    if (this.#failures >= this.#failureThreshold) this.#openedAt = now;
  }

  get isOpen() { return this.#openedAt !== 0; }
}
