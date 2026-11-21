// ── Removing an integration's redemption webhooks at the provider ───────────
// An integration has up to one webhook endpoint per environment (live and
// test), each created with that environment's credentials. Whoever deletes an
// integration (disconnect, workspace delete) calls removeIntegrationWebhooks
// AFTER the database delete succeeded, so a failed delete never leaves a
// connected-looking integration whose redemptions no longer arrive.

import type { Bindings } from "../bindings";
import { decrypt, tokenEncryptionSecret } from "../lib/crypto";
import { errorSummary } from "../lib/log";
import {
  accessTokenEncFor,
  createProvider,
  providerConfigFor,
  webhookSlotFor,
  ProviderError,
  type IntegrationCredentials,
  type IntegrationWebhookColumns,
} from "./providers";
import { describeError } from "./integration-health.service";

type Environment = "live" | "test";

/** The integration columns removal needs (a full `integrations` row works). */
export type IntegrationForWebhookRemoval = Pick<IntegrationCredentials, "provider" | "liveAccessTokenEnc" | "testAccessTokenEnc" | "providerAccountId" | "testProviderAccountId"> &
  IntegrationWebhookColumns & { id: string };

export interface WebhookRemovalResult {
  /** Environments whose endpoint is gone (deleted now, or already gone at the provider). */
  removed: Environment[];
  /** Environments whose endpoint may still exist, with the reason. */
  failed: { environment: Environment; error: string }[];
}

/**
 * Delete every provider webhook endpoint recorded on the integration, each
 * with the credentials of the environment it was created in. Never throws;
 * failures are logged and returned. A provider without deleteWebhook, or a
 * slot without credentials to delete it with, counts as failed (the endpoint
 * may still exist; the provider disables it once deliveries keep failing).
 */
export async function removeIntegrationWebhooks(
  env: Pick<Bindings, "TOKEN_ENCRYPTION_KEY" | "BETTER_AUTH_SECRET">,
  integration: IntegrationForWebhookRemoval,
): Promise<WebhookRemovalResult> {
  const result: WebhookRemovalResult = { removed: [], failed: [] };
  for (const environment of ["live", "test"] as const) {
    const { endpointId } = webhookSlotFor(integration, environment);
    if (!endpointId) continue;
    try {
      const tokenEnc = accessTokenEncFor(integration, environment);
      if (!tokenEnc) throw new Error(`no ${environment} credentials to delete it with`);
      const apiKey = await decrypt(tokenEnc, tokenEncryptionSecret(env));
      const provider = createProvider(integration.provider, providerConfigFor(integration, environment, apiKey));
      if (!provider.deleteWebhook) throw new Error(`${integration.provider} can't delete webhooks`);
      await provider.deleteWebhook(endpointId);
      result.removed.push(environment);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        result.removed.push(environment); // already gone
        continue;
      }
      console.error("[integrations] could not remove provider webhook", {
        integrationId: integration.id,
        provider: integration.provider,
        environment,
        endpointId,
        error: errorSummary(err),
      });
      result.failed.push({ environment, error: describeError(err) });
    }
  }
  return result;
}
