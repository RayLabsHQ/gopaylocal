/**
 * Send email via Azure Communication Services REST API.
 * Uses HMAC-SHA256 auth from the connection string.
 */

import type { Bindings } from "../bindings";
import { isSelfHosted } from "./entitlements";

/** The hosted service's sender, on the mail domain linked to its ACS resource. */
export const HOSTED_SENDER_ADDRESS = "DoNotReply@mail.gopaylocal.com";

/**
 * The sender address for outgoing email: EMAIL_FROM when set, otherwise the
 * hosted sender on the hosted service. Self-hosted with EMAIL_FROM unset:
 * null, and callers skip sending, because ACS only accepts a sender on a
 * domain linked to the deployment's own resource and would refuse the hosted one.
 */
export function senderAddressFor(env: Pick<Bindings, "EMAIL_FROM" | "SELF_HOSTED">): string | null {
  const configured = env.EMAIL_FROM?.trim();
  if (configured) return configured;
  return isSelfHosted(env) ? null : HOSTED_SENDER_ADDRESS;
}

/** Where the hosted service's replies and help questions go. */
export const HOSTED_SUPPORT_ADDRESS = "support@gopaylocal.com";

/**
 * Where replies to GoPayLocal's emails go, and the help address the emails
 * show: SUPPORT_EMAIL when set, otherwise the hosted support address on the
 * hosted service. Self-hosted with SUPPORT_EMAIL unset: null (no reply-to, no
 * help line), never the hosted address.
 */
export function supportAddressFor(env: Pick<Bindings, "SUPPORT_EMAIL" | "SELF_HOSTED">): string | null {
  const configured = env.SUPPORT_EMAIL?.trim();
  if (configured) return configured;
  return isSelfHosted(env) ? null : HOSTED_SUPPORT_ADDRESS;
}

const HOSTED_APP_BASE_URL = "https://app.gopaylocal.com";

/**
 * The dashboard's origin, for links in emails: APP_BASE_URL, else the hosted
 * dashboard when hosted. Self-hosted with APP_BASE_URL unset: null, and no
 * email is sent (a link to gopaylocal.com would be wrong there).
 */
export function appUrlFor(env: Pick<Bindings, "APP_BASE_URL" | "SELF_HOSTED">): string | null {
  return env.APP_BASE_URL ?? (isSelfHosted(env) ? null : HOSTED_APP_BASE_URL);
}

/**
 * A subject line from text that may hold user-controlled names: control
 * characters (a CR/LF could start a header) become spaces, and it is capped.
 */
export function subjectLine(value: string, max = 120): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function sendEmail(
  connectionString: string,
  options: {
    to: string;
    subject: string;
    html: string;
    /** The plain-text version, for clients that don't show HTML. */
    text?: string;
    /** Where a reply goes instead of the no-reply sender. */
    replyTo?: string | null;
    /** From senderAddressFor(env). */
    senderAddress: string;
  },
): Promise<void> {
  const { endpoint, accessKey } = parseConnectionString(connectionString);
  const { senderAddress } = options;

  const body = JSON.stringify({
    senderAddress,
    content: {
      subject: options.subject,
      html: options.html,
      ...(options.text ? { plainText: options.text } : {}),
    },
    recipients: {
      to: [{ address: options.to }],
    },
    ...(options.replyTo ? { replyTo: [{ address: options.replyTo }] } : {}),
  });

  const url = new URL("/emails:send?api-version=2023-03-31", endpoint);
  const date = new Date().toUTCString();
  const contentHash = await sha256Base64(body);

  const stringToSign = [
    "POST",
    url.pathname + url.search,
    `${date};${url.host};${contentHash}`,
  ].join("\n");

  const signature = await hmacSha256Base64(accessKey, stringToSign);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ms-date": date,
      "x-ms-content-sha256": contentHash,
      Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ACS email failed (${response.status}): ${text}`);
  }
}

function parseConnectionString(cs: string): { endpoint: string; accessKey: string } {
  const parts: Record<string, string> = {};
  for (const part of cs.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const key = part.slice(0, idx).toLowerCase();
      const value = part.slice(idx + 1);
      // Handle endpoint which has = in the value (https://...)
      if (key === "endpoint") {
        parts[key] = value;
      } else if (key === "accesskey") {
        // accesskey value may have been split by ; — reconstruct
        parts[key] = parts[key] ? parts[key] + ";" + part : value;
      } else {
        parts[key] = value;
      }
    }
  }
  if (!parts.endpoint || !parts.accesskey) {
    throw new Error("Invalid ACS connection string");
  }
  return { endpoint: parts.endpoint, accessKey: parts.accesskey };
}

async function sha256Base64(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function hmacSha256Base64(keyBase64: string, data: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
