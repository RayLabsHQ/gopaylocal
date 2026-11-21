// ── Network guard ───────────────────────────────────────────────────────────
// Second line of defence for the live-mode guard. The first line (safety.ts)
// decides from the credentials and the provider profile; this one watches what
// the provider actually connects to. Every provider API is HTTPS, and every
// HTTP client in use (undici behind global fetch, which the Paddle and Dodo
// SDKs and Stripe's fetch client all call) opens its socket through
// tls.connect(), so wrapping it sees every connection, before DNS or any byte
// is sent. In a TEST run, a connection to a known LIVE host is refused: if a
// provider ignores ProviderConfig.environment, the run fails instead of
// touching live data. For a provider whose API is the merchant's own host
// (WooCommerce), `allowOnly` refuses every other host, so a run shows the
// credentials went nowhere else. Every host contacted is recorded for the report.

import tls from 'node:tls';

export type HostRule = string | RegExp;

export interface NetworkGuard {
  readonly hosts: ReadonlySet<string>;
  readonly blocked: readonly string[];
  restore(): void;
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

export function hostMatches(host: string, rules: readonly HostRule[]): boolean {
  const h = normalizeHost(host);
  return rules.some((r) => (typeof r === 'string' ? h === normalizeHost(r) : r.test(h)));
}

/** Pull the target host out of any tls.connect() call signature. */
export function hostOfConnectArgs(args: unknown[]): string | undefined {
  for (const a of args) {
    if (a && typeof a === 'object') {
      const o = a as { servername?: unknown; host?: unknown };
      if (typeof o.servername === 'string' && o.servername) return normalizeHost(o.servername);
      if (typeof o.host === 'string' && o.host) return normalizeHost(o.host);
    }
  }
  // tls.connect(port, host, ...)
  if (typeof args[0] === 'number' && typeof args[1] === 'string') return normalizeHost(args[1]);
  return undefined;
}

export interface NetworkGuardOptions {
  /** Refuse connections to these hosts. */
  block: readonly HostRule[];
  /**
   * When set, refuse every host that matches none of these rules, including a
   * connection whose host can't be determined (fails closed). An empty list
   * refuses everything.
   */
  allowOnly?: readonly HostRule[];
  reason: string;
}

export function installNetworkGuard(opts: NetworkGuardOptions): NetworkGuard {
  const original = tls.connect;
  const hosts = new Set<string>();
  const blocked: string[] = [];
  const guarded = function (this: unknown, ...args: unknown[]) {
    const host = hostOfConnectArgs(args);
    if (host) hosts.add(host);
    const refused =
      (host !== undefined && hostMatches(host, opts.block)) ||
      (opts.allowOnly !== undefined && (host === undefined || !hostMatches(host, opts.allowOnly)));
    if (refused) {
      const shown = host ?? '(unknown host)';
      blocked.push(shown);
      throw new Error(`verify-provider network guard refused a connection to ${shown}: ${opts.reason}`);
    }
    return (original as (...a: unknown[]) => tls.TLSSocket).apply(this, args);
  };
  (tls as { connect: unknown }).connect = guarded;
  return {
    hosts,
    blocked,
    restore: () => {
      (tls as { connect: unknown }).connect = original;
    },
  };
}
