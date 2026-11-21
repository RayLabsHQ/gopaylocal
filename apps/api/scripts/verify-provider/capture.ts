// ── Webhook capture ─────────────────────────────────────────────────────────
// A one-shot local receiver: listens on 127.0.0.1, records the first
// POST/PUT/PATCH exactly as received (headers + raw body bytes as UTF-8), and
// answers 200. A setup ping the caller's `skip` recognises is answered but not
// recorded. Expose the port through any HTTPS tunnel and pass the tunnel URL
// as --webhook-url; the written file is the input for --replay.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedDelivery {
  capturedAt: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string;
}

export interface CaptureHandle {
  /** Resolves with the first captured delivery. */
  done: Promise<CapturedDelivery>;
  /** Resolves once the server is listening, with the actual port. */
  listening: Promise<{ host: string; port: number }>;
  close(): void;
}

export interface CaptureOptions {
  port: number;
  host?: string;
  /**
   * A delivery this returns true for is answered 200 but not captured, and the
   * server keeps waiting: a provider's setup ping (PaymentProvider.isHandshake),
   * such as the unsigned `webhook_id=<id>` WooCommerce sends while a webhook is
   * being created. If it throws, the delivery is captured: never lose one.
   */
  skip?: (delivery: CapturedDelivery) => boolean;
  /** Called with each skipped delivery. */
  onSkip?: (delivery: CapturedDelivery) => void;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function captureOnce(opts: CaptureOptions): CaptureHandle {
  const host = opts.host ?? '127.0.0.1';
  let resolveDone!: (d: CapturedDelivery) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<CapturedDelivery>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  let captured = false;

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('GoPayLocal verify-provider capture server: waiting for a webhook POST\n');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"received":true}');
      if (captured) return;
      const headers: Record<string, string> = {};
      const raw = req.rawHeaders;
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i]!.toLowerCase();
        headers[name] = headers[name] !== undefined ? `${headers[name]}, ${raw[i + 1]}` : raw[i + 1]!;
      }
      const delivery: CapturedDelivery = {
        capturedAt: new Date().toISOString(),
        method,
        path: req.url ?? '/',
        headers,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      };
      let skipped = false;
      try {
        skipped = opts.skip?.(delivery) === true;
      } catch {
        skipped = false;
      }
      if (skipped) {
        opts.onSkip?.(delivery);
        return;
      }
      captured = true;
      resolveDone(delivery);
      server.close();
    });
  });

  const listening = new Promise<{ host: string; port: number }>((resolve, reject) => {
    server.once('error', (err) => {
      reject(err);
      rejectDone(err);
    });
    server.listen(opts.port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ host, port: addr.port });
    });
  });

  return {
    done,
    listening,
    close: () => {
      server.close();
      if (!captured) rejectDone(new Error('capture server closed before a delivery arrived'));
    },
  };
}
