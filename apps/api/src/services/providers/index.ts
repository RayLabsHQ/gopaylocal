// ── Provider Factory ────────────────────────────────────────────────────────
// Creates the correct payment provider instance based on the integration type.
// This is the main entry point for all provider operations.

import type { PaymentProvider, ProviderConfig } from './types';
import type { IntegrationProvider } from '@gopaylocal/shared/types';
import { ProviderError } from './types';
import { DodoProvider } from './dodo';
import { StripeProvider } from './stripe';
import { PaddleProvider } from './paddle';
import { GumroadProvider } from './gumroad';
import { ChargebeeProvider } from './chargebee';
import { WhopProvider } from './whop';
import { PolarProvider } from './polar';
import { CreemProvider } from './creem';
import { WooCommerceProvider } from './woocommerce';

/**
 * Create a payment provider instance for the given integration.
 *
 * @param provider - The provider type (e.g. 'stripe', 'paddle')
 * @param config - Provider-specific configuration (API key, environment, etc.)
 * @returns A PaymentProvider implementation
 * @throws ProviderError if the provider is not supported
 */
export function createProvider(
  provider: IntegrationProvider,
  config: ProviderConfig,
): PaymentProvider {
  switch (provider) {
    case 'dodopayments':
      return new DodoProvider(config);
    case 'stripe':
      return new StripeProvider(config);
    case 'paddle':
      return new PaddleProvider(config);
    case 'gumroad':
      return new GumroadProvider(config);
    case 'chargebee':
      return new ChargebeeProvider(config);
    case 'whop':
      return new WhopProvider(config);
    case 'polar':
      return new PolarProvider(config);
    case 'creem':
      return new CreemProvider(config);
    case 'woocommerce':
      return new WooCommerceProvider(config);
    default:
      throw new ProviderError(
        provider as string,
        'init',
        `Unsupported provider: ${provider}`,
      );
  }
}

/** The columns of an `integrations` row that provider construction depends on. */
export interface IntegrationCredentials {
  provider: IntegrationProvider;
  liveAccessTokenEnc: string | null;
  testAccessTokenEnc: string | null;
  providerAccountId: string | null;
  /** Test-mode account id when it differs from the live one; null = same. */
  testProviderAccountId?: string | null;
}

type Environment = 'live' | 'test';

/** The encrypted access token stored for `environment`, or null if none. */
export function accessTokenEncFor(
  integration: Pick<IntegrationCredentials, 'liveAccessTokenEnc' | 'testAccessTokenEnc'>,
  environment: Environment,
): string | null {
  return environment === 'test' ? integration.testAccessTokenEnc : integration.liveAccessTokenEnc;
}

/**
 * The provider account id for `environment`: test mode uses its own id when
 * one was given (a Whop sandbox company is a different account), otherwise
 * the shared one.
 */
export function providerAccountIdFor(
  integration: Pick<IntegrationCredentials, 'providerAccountId' | 'testProviderAccountId'>,
  environment: Environment,
): string | null {
  if (environment === 'test') return integration.testProviderAccountId ?? integration.providerAccountId ?? null;
  return integration.providerAccountId ?? null;
}

/** The webhook columns of an `integrations` row: one endpoint per environment. */
export interface IntegrationWebhookColumns {
  webhookEndpointId: string | null;
  webhookSecretEnc: string | null;
  testWebhookEndpointId: string | null;
  testWebhookSecretEnc: string | null;
}

export interface WebhookSlot {
  endpointId: string | null;
  secretEnc: string | null;
}

/** The redemption webhook provisioned for `environment` (live: the unprefixed columns). */
export function webhookSlotFor(integration: IntegrationWebhookColumns, environment: Environment): WebhookSlot {
  return environment === 'test'
    ? { endpointId: integration.testWebhookEndpointId, secretEnc: integration.testWebhookSecretEnc }
    : { endpointId: integration.webhookEndpointId, secretEnc: integration.webhookSecretEnc };
}

/** The column values that store `slot` as the webhook for `environment`. */
export function webhookSlotColumns(
  environment: Environment,
  slot: WebhookSlot,
): Partial<IntegrationWebhookColumns> {
  return environment === 'test'
    ? { testWebhookEndpointId: slot.endpointId, testWebhookSecretEnc: slot.secretEnc }
    : { webhookEndpointId: slot.endpointId, webhookSecretEnc: slot.secretEnc };
}

/** Path the provider posts redemption webhooks to (test webhooks get a /test suffix). */
export function webhookCallbackPath(
  provider: string,
  integrationId: string,
  environment: Environment,
): string {
  return `/v1/webhooks/${provider}/${integrationId}${environment === 'test' ? '/test' : ''}`;
}

/**
 * Provider config for an integration in one environment. Every caller must go
 * through this so the key, the environment (live vs sandbox host) and the
 * account id always travel together.
 */
export function providerConfigFor(
  integration: Pick<IntegrationCredentials, 'providerAccountId' | 'testProviderAccountId'>,
  environment: Environment,
  apiKey: string,
): ProviderConfig {
  return {
    apiKey,
    environment,
    siteId: providerAccountIdFor(integration, environment) ?? undefined,
  };
}

export type {
  PaymentProvider,
  CreateDiscountParams,
  CheckoutUrlParams,
  ProviderDiscount,
  ProviderProduct,
  ProviderConfig,
  RedemptionEvent,
  RedemptionDiscount,
  ProvisionedWebhook,
} from './types';

export {
  ProviderError,
  ProviderAuthError,
  ProviderNotFoundError,
} from './types';
