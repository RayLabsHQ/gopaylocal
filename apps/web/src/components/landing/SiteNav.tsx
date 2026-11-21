import {
  NavMenu,
  NavPanelGrid,
  NavPanelItem,
} from '../ui/nav-menu';
import {
  Globe, Shield, TrendingUp, Banknote, Sparkles, Zap,
  Building2, Package, GraduationCap, Terminal,
} from 'lucide-react';
import { PPP_MULTIPLIERS } from '@gopaylocal/shared/parity';

const features = [
  { icon: <Globe className="h-4 w-4" />, title: `${Object.keys(PPP_MULTIPLIERS).length} Countries`, description: 'Built-in PPP data, edge geo-detection', href: '/#features' },
  { icon: <Shield className="h-4 w-4" />, title: 'VPN Detection', description: 'ASN + IP proxy blocking', href: '/#features' },
  { icon: <TrendingUp className="h-4 w-4" />, title: 'A/B Testing', description: 'Compare two discount campaigns', href: '/#features' },
  { icon: <Banknote className="h-4 w-4" />, title: 'Multi-Currency', description: 'Show local currency prices', href: '/#features' },
  { icon: <Sparkles className="h-4 w-4" />, title: 'Charm Pricing', description: 'Psychology-driven rounding', href: '/#features' },
  { icon: <Zap className="h-4 w-4" />, title: 'Coupon Codes', description: 'Created in your payment platform', href: '/#features' },
];

const useCases = [
  { icon: <Building2 className="h-4 w-4" />, title: 'SaaS Companies', description: 'Subscription pricing by country', href: '/use-cases/saas' },
  { icon: <Package className="h-4 w-4" />, title: 'Digital Products', description: 'Templates, ebooks, assets', href: '/use-cases/digital-products' },
  { icon: <GraduationCap className="h-4 w-4" />, title: 'Online Courses', description: 'Fair pricing for students', href: '/use-cases/online-courses' },
  { icon: <Terminal className="h-4 w-4" />, title: 'Developer Tools', description: 'Grow your dev community', href: '/use-cases/developer-tools' },
];

// `slug` is the docs page slug; `logoSlug` is the local logo filename where
// the two differ (the dodo-payments page uses dodo.svg).
const integrations = [
  { name: 'Stripe', slug: 'stripe', logoSlug: 'stripe', desc: 'Coupons API' },
  { name: 'Paddle', slug: 'paddle', logoSlug: 'paddle', desc: 'Discounts API' },
  { name: 'Gumroad', slug: 'gumroad', logoSlug: 'gumroad', desc: 'Offer codes' },
  { name: 'Chargebee', slug: 'chargebee', logoSlug: 'chargebee', desc: 'Coupons API' },
  { name: 'Dodo', slug: 'dodo-payments', logoSlug: 'dodo', desc: 'Discounts API' },
  { name: 'Polar', slug: 'polar', logoSlug: 'polar', desc: 'Discounts API' },
  { name: 'Whop', slug: 'whop', logoSlug: 'whop', desc: 'Promo codes' },
  { name: 'Creem', slug: 'creem', logoSlug: 'creem', desc: 'Discount codes' },
  { name: 'WooCommerce', slug: 'woocommerce', logoSlug: 'woocommerce', desc: 'Coupons API' },
];

export function SiteNav() {
  return (
    <NavMenu
      items={[
        {
          label: 'Features',
          panel: (
            <NavPanelGrid columns={2}>
              {features.map((f) => (
                <NavPanelItem
                  key={f.title}
                  icon={f.icon}
                  title={f.title}
                  description={f.description}
                  href={f.href}
                />
              ))}
            </NavPanelGrid>
          ),
        },
        {
          label: 'Use Cases',
          panel: (
            <NavPanelGrid columns={2}>
              {useCases.map((uc) => (
                <NavPanelItem
                  key={uc.title}
                  icon={uc.icon}
                  title={uc.title}
                  description={uc.description}
                  href={uc.href}
                />
              ))}
            </NavPanelGrid>
          ),
        },
        {
          label: 'Integrations',
          panel: (
            <div className="w-[460px] p-2">
              <div className="grid grid-cols-2 gap-1.5">
                {integrations.map((i) => (
                  <a
                    key={i.name}
                    href={`https://docs.gopaylocal.com/integrations/${i.slug}`}
                    className="flex items-center gap-3 px-3.5 py-3 border border-border hover:border-text-muted hover:bg-bg-surface transition-colors group no-underline"
                  >
                    <img
                      src={`/logos/${i.logoSlug}.svg`}
                      alt={i.name}
                      className="h-7 w-7 shrink-0 object-contain"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary group-hover:text-accent-text transition-colors no-underline">
                        {i.name}
                      </p>
                      <p className="text-[13px] text-text-muted mt-1 no-underline">{i.desc}</p>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          ),
        },
        { label: 'Demo', href: '/#demo' },
        { label: 'Pricing', href: '/#pricing' },
        { label: 'Docs', href: 'https://docs.gopaylocal.com' },
      ]}
    />
  );
}
