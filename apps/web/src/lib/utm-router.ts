import type { LandingVariant } from './landing-data';

const DEV_SOURCES = ['github', 'hackernews', 'hn', 'devto', 'dev.to', 'stackoverflow', 'reddit'];
const REVENUE_SOURCES = ['linkedin', 'twitter', 'facebook', 'google-ads', 'saastr', 'producthunt'];

export function resolveVariant(url: URL, cookies: Record<string, string | undefined>): LandingVariant {
  // Check explicit variant override
  const explicitVariant = url.searchParams.get('variant');
  if (explicitVariant === 'dev' || explicitVariant === 'revenue' || explicitVariant === 'full') {
    return explicitVariant;
  }

  // Check cookie for returning visitors
  const cookieVariant = cookies['gpl_variant'];
  if (cookieVariant === 'dev' || cookieVariant === 'revenue' || cookieVariant === 'full') {
    return cookieVariant;
  }

  // Route based on UTM source/medium
  const utmSource = (url.searchParams.get('utm_source') || '').toLowerCase();
  const utmMedium = (url.searchParams.get('utm_medium') || '').toLowerCase();
  const utmCampaign = (url.searchParams.get('utm_campaign') || '').toLowerCase();

  if (DEV_SOURCES.includes(utmSource) || utmMedium === 'developer' || utmCampaign.includes('dev')) {
    return 'dev';
  }

  if (REVENUE_SOURCES.includes(utmSource) || utmMedium === 'cpc' || utmMedium === 'paid' || utmCampaign.includes('revenue') || utmCampaign.includes('growth')) {
    return 'revenue';
  }

  return 'full';
}
