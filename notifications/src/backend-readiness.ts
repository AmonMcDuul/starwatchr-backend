export class MailServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly stage: 'wake' | 'delivery',
    public readonly retryable: boolean,
  ) {
    super(stage === 'wake' ? 'Backend is not ready' : 'Email delivery failed');
  }
}

// One readiness request per worker at a time. No periodic keep-alive.
export class BackendReadiness {
  private readyUntil = 0;
  private connection = '';
  private inFlight?: Promise<void>;
  private unavailableUntil = 0;
  private lastFailure?: MailServiceError;

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly pause: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly clock: () => number = Date.now,
  ) {}

  async ensure(relay: string, key: string): Promise<number> {
    // A setting change must not reuse readiness from a different endpoint or key.
    const connection = relay + '\n' + key;
    if (this.connection !== connection) {
      this.connection = connection;
      this.readyUntil = 0;
      this.unavailableUntil = 0;
    }
    if (this.lastFailure && this.unavailableUntil > this.clock()) throw this.lastFailure;
    if (this.readyUntil > this.clock()) return 0;
    const started = this.clock();
    if (!this.inFlight) {
      this.inFlight = this.wake(relay, key)
        .catch((error: MailServiceError) => {
          this.lastFailure = error;
          this.unavailableUntil = this.clock() + 60_000;
          throw error;
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }
    await this.inFlight;
    return Math.max(0, this.clock() - started);
  }

  invalidate() {
    this.readyUntil = 0;
  }

  private async wake(relay: string, key: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.request(relay.replace(/\/$/, '') + '/ready', {
          method: 'GET',
          headers: { 'X-Notification-Key': key },
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        // Do not read or log Azure error pages; these can contain infrastructure details.
        await response.body?.cancel();
        if (response.status === 204) {
          this.readyUntil = this.clock() + 5 * 60_000;
          return;
        }
        const retryable =
          response.status === 403 ||
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        throw new MailServiceError(response.status, 'wake', retryable);
      } catch (error) {
        const failure =
          error instanceof MailServiceError ? error : new MailServiceError(503, 'wake', true);
        // Quota exhaustion cannot be fixed by more immediate wake requests.
        if (
          !failure.retryable ||
          failure.status === 403 ||
          failure.status === 429 ||
          attempt === 2
        ) {
          throw failure;
        }
        await this.pause(2000 * (attempt + 1));
      }
    }
  }
}
