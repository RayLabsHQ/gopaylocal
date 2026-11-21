// ── Step runner ─────────────────────────────────────────────────────────────
// Runs named checks, turns every outcome (return, throw, timeout, interrupt)
// into a PASS / FAIL / SKIPPED / BLOCKED record, and guarantees that registered
// cleanup actions run afterwards no matter how the checks ended.
//
//   PASS     the check ran and its assertion held
//   FAIL     the check ran and threw, timed out, or its assertion did not hold
//   SKIPPED  deliberately not run: unsupported by this provider, or not requested
//   BLOCKED  could not run because an earlier step failed or the run was interrupted

export type StepStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'BLOCKED';
export type StepPhase = 'main' | 'cleanup';

export interface StepError {
  name: string;
  message: string;
  operation?: string;
  statusCode?: number;
  providerErrorCode?: string;
}

export interface StepResult {
  name: string;
  status: StepStatus;
  detail: string;
  phase: StepPhase;
  durationMs: number;
  error?: StepError;
  data?: Record<string, unknown>;
}

export interface StepOutcome {
  status?: StepStatus; // default PASS
  detail: string;
  data?: Record<string, unknown>;
}

export class StepTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      `timed out after ${Math.round(timeoutMs / 1000)}s (the request may still complete at the provider)`,
    );
    this.name = 'StepTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

interface Cleanup {
  name: string;
  run: () => Promise<void>;
  /** Shown instead of running when cleanup is skipped (--keep). */
  keepHint: string;
}

export interface RunnerOptions {
  timeoutMs: number;
  onResult?: (result: StepResult) => void;
  clock?: () => number;
}

/** Duck-typed so it works for ProviderError from any module instance. */
export function toStepError(err: unknown): StepError {
  if (err && typeof err === 'object') {
    const e = err as {
      name?: unknown;
      message?: unknown;
      operation?: unknown;
      statusCode?: unknown;
      providerErrorCode?: unknown;
    };
    return {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : String(err),
      ...(typeof e.operation === 'string' ? { operation: e.operation } : {}),
      ...(typeof e.statusCode === 'number' ? { statusCode: e.statusCode } : {}),
      ...(typeof e.providerErrorCode === 'string' ? { providerErrorCode: e.providerErrorCode } : {}),
    };
  }
  return { name: 'Error', message: String(err) };
}

export function describeError(err: unknown): string {
  const e = toStepError(err);
  const extras = [
    e.statusCode !== undefined ? `HTTP ${e.statusCode}` : null,
    e.providerErrorCode ? `code ${e.providerErrorCode}` : null,
  ].filter(Boolean);
  const cause =
    err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
  return `${e.name}: ${e.message}${extras.length ? ` [${extras.join(', ')}]` : ''}${cause}`;
}

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(ms)), ms);
  });
  // Promise.resolve().then(run) turns a synchronous throw into a rejection.
  return Promise.race([Promise.resolve().then(run), timeout]).finally(() => clearTimeout(timer));
}

export class StepRunner {
  readonly results: StepResult[] = [];
  private cleanups: Cleanup[] = [];
  private interrupted = false;
  private phase: StepPhase = 'main';
  private readonly clock: () => number;
  private readonly opts: RunnerOptions;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? (() => Date.now());
  }

  /** Stop starting new main-phase steps; cleanup still runs. */
  interrupt(): void {
    this.interrupted = true;
  }

  get isInterrupted(): boolean {
    return this.interrupted;
  }

  get pendingCleanups(): ReadonlyArray<{ name: string; keepHint: string }> {
    return this.cleanups;
  }

  async step(name: string, fn: () => Promise<StepOutcome>): Promise<StepResult> {
    if (this.interrupted && this.phase === 'main') {
      return this.record({ name, status: 'BLOCKED', detail: 'interrupted before this step ran', durationMs: 0 });
    }
    const start = this.clock();
    try {
      const outcome = await withTimeout(fn, this.opts.timeoutMs);
      return this.record({
        name,
        status: outcome.status ?? 'PASS',
        detail: outcome.detail,
        durationMs: this.clock() - start,
        ...(outcome.data ? { data: outcome.data } : {}),
      });
    } catch (err) {
      return this.record({
        name,
        status: 'FAIL',
        detail: describeError(err),
        error: toStepError(err),
        durationMs: this.clock() - start,
      });
    }
  }

  skip(name: string, detail: string): StepResult {
    return this.record({ name, status: 'SKIPPED', detail, durationMs: 0 });
  }

  block(name: string, detail: string): StepResult {
    return this.record({ name, status: 'BLOCKED', detail, durationMs: 0 });
  }

  fail(name: string, detail: string, err?: unknown): StepResult {
    return this.record({
      name,
      status: 'FAIL',
      detail,
      durationMs: 0,
      ...(err !== undefined ? { error: toStepError(err) } : {}),
    });
  }

  /**
   * Register a cleanup action. Cleanups run in reverse registration order once
   * the main phase ends. `run` normally records its own steps via step().
   */
  defer(name: string, run: () => Promise<void>, keepHint: string): void {
    this.cleanups.push({ name, run, keepHint });
  }

  /** Run (or, with keep, skip) every registered cleanup. Never throws. */
  async runCleanups(opts: { keep: boolean } = { keep: false }): Promise<void> {
    this.phase = 'cleanup';
    const pending = this.cleanups.reverse();
    this.cleanups = [];
    for (const c of pending) {
      if (opts.keep) {
        this.skip(c.name, `kept (--keep). ${c.keepHint}`);
        continue;
      }
      try {
        await c.run();
      } catch (err) {
        this.fail(c.name, `cleanup threw: ${describeError(err)}`, err);
      }
    }
  }

  private record(r: Omit<StepResult, 'phase'>): StepResult {
    const result: StepResult = { ...r, phase: this.phase };
    this.results.push(result);
    this.opts.onResult?.(result);
    return result;
  }
}

/**
 * Run `body`, then the runner's cleanups, unconditionally. An exception that
 * escapes `body` (a bug, not a check failure) is recorded as a FAIL instead of
 * skipping cleanup.
 */
export async function runWithCleanup(
  runner: StepRunner,
  body: () => Promise<void>,
  cleanupOptions: () => { keep: boolean },
): Promise<void> {
  try {
    await body();
  } catch (err) {
    runner.fail('unexpected-error', describeError(err), err);
  } finally {
    await runner.runCleanups(cleanupOptions());
  }
}

export function summarize(results: StepResult[]): Record<StepStatus, number> {
  const counts: Record<StepStatus, number> = { PASS: 0, FAIL: 0, SKIPPED: 0, BLOCKED: 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}
