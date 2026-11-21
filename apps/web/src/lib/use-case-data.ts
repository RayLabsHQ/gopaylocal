import {
  DEFAULT_SETTINGS,
  INTEGRATION_COUNT,
  PPP_COUNTRY_COUNT,
  defaultDiscountLabel,
  defaultPrice,
} from './landing-data';

export interface UseCaseData {
  tag: string;
  headline: string;
  subline: string;
  secondaryCta: string;
  problem: {
    title: string;
    subtitle: string;
    columns: { country: string; context: string; conversion: string; positive: boolean }[];
  };
  features: {
    title: string;
    items: { icon: string; title: string; description: string }[];
  };
  // Honest category proof — replaces fabricated testimonials. Swap in real
  // quotes here once collected post-launch.
  proof: {
    label: string;
    description: string;
  };
  cta: {
    title: string;
    subtitle: string;
  };
}

export const useCases: Record<string, UseCaseData> = {
  saas: {
    tag: 'Use Case — SaaS Companies',
    headline: 'Your SaaS is global.\nYour pricing should be too.',
    subline: "Most of the world can't afford US subscription pricing. GoPayLocal automatically adjusts your prices by country using built-in purchasing-power data — so you convert trials that would otherwise bounce, reduce price-driven churn, and grow MRR from every market.",
    secondaryCta: 'Read the Quickstart',
    problem: {
      title: 'The SaaS pricing problem',
      subtitle: `You charge $49/mo everywhere. With ${DEFAULT_SETTINGS}, this is what visitors pay with their code.`,
      columns: [
        { country: 'Without PPP', context: '$49/mo in every country', conversion: 'One price for all', positive: false },
        { country: 'USA', context: defaultDiscountLabel('US'), conversion: `${defaultPrice(49, 'US')}/mo`, positive: true },
        { country: 'Poland', context: defaultDiscountLabel('PL'), conversion: `${defaultPrice(49, 'PL')}/mo`, positive: true },
        { country: 'Brazil', context: defaultDiscountLabel('BR'), conversion: `${defaultPrice(49, 'BR')}/mo`, positive: true },
      ],
    },
    features: {
      title: 'Built for subscription businesses.',
      items: [
        { icon: 'repeat', title: 'Recurring Billing Support', description: 'Works with monthly and annual subscriptions. Codes are created as recurring discounts where the payment platform supports it, so renewals keep the local price.' },
        { icon: 'users', title: 'Trial Conversion Boost', description: 'Show fair local pricing during the trial so price-sensitive markets see an offer they can actually afford before the trial ends.' },
        { icon: 'shield', title: 'Churn Reduction', description: 'A price people can afford locally lowers price-driven churn.' },
        { icon: 'credit-card', title: 'Stripe + Paddle Native', description: 'GoPayLocal creates the coupons in Stripe and the discounts in Paddle for you. Your checkout can pass the code so buyers never type it.' },
        { icon: 'globe', title: `${PPP_COUNTRY_COUNT} Countries Built In`, description: 'Purchasing-power multipliers and default discount tiers for each one. Set your own maximum discount.' },
        { icon: 'activity', title: 'Redemption Analytics', description: 'Track impressions, code copies, redemptions and discount given per country. See which markets respond and adjust your discounts.' },
      ],
    },
    proof: {
      label: 'Why PPP works for SaaS',
      description: 'B2B buyers outside the US routinely bounce at dollar pricing. A fair local price at checkout converts trials that would otherwise churn, while VPN detection keeps the discount away from visitors hiding their location.',
    },
    cta: {
      title: 'Stop losing SaaS revenue\nto flat global pricing.',
      subtitle: `Free to try. Works with Stripe, Paddle, and ${INTEGRATION_COUNT - 2} more. Set up in minutes.`,
    },
  },
  'digital-products': {
    tag: 'Use Case — Digital Products',
    headline: 'Sell templates, ebooks,\nand assets worldwide.',
    subline: "A $39 Notion template costs the same everywhere, but purchasing power doesn't. Adjust pricing automatically and turn bounced visitors into happy customers.",
    secondaryCta: 'Read the Quickstart',
    problem: {
      title: 'The digital product pricing gap',
      subtitle: `Your $39 template. With ${DEFAULT_SETTINGS}, this is what visitors pay with their code.`,
      columns: [
        { country: 'Without PPP', context: '$39 in every country', conversion: 'One price for all', positive: false },
        { country: 'USA', context: defaultDiscountLabel('US'), conversion: `${defaultPrice(39, 'US')}`, positive: true },
        { country: 'Turkey', context: defaultDiscountLabel('TR'), conversion: `${defaultPrice(39, 'TR')}`, positive: true },
        { country: 'Nigeria', context: defaultDiscountLabel('NG'), conversion: `${defaultPrice(39, 'NG')}`, positive: true },
      ],
    },
    features: {
      title: 'Built for digital product sellers.',
      items: [
        { icon: 'download', title: 'One-Time Purchase Support', description: 'Works with single purchases, bundles, and tiered products. No recurring billing complexity.' },
        { icon: 'shopping-bag', title: 'Gumroad + Polar', description: 'Native integration with top digital product platforms.' },
        { icon: 'package', title: 'Per-Product Campaigns', description: 'Give each product its own campaign and discounts. The banner shows the campaign for the product on the page.' },
        { icon: 'link', title: 'Codes on Your Platform', description: 'GoPayLocal creates the discount code in Gumroad, Polar or your other platform. Visitors copy it from the banner at checkout.' },
        { icon: 'sparkles', title: 'Charm Pricing', description: 'With Round to X9, for example, ₹1,583.75 becomes ₹1,599: a converted price rounds up to a local price point, never down. Local prices are estimates at the day\'s exchange rate.' },
        { icon: 'trending-up', title: 'Sales Analytics', description: 'Track which countries buy, which discounts convert, and where to focus your marketing.' },
      ],
    },
    proof: {
      label: 'Why PPP works for digital products',
      description: 'A template, ebook, or asset has near-zero marginal cost, so every sale at a fair local price is pure incremental revenue — from buyers who would never have paid the US price in the first place.',
    },
    cta: {
      title: "Your global audience is ready.\nYour pricing isn't.",
      subtitle: `Free to try. Works with Gumroad, Polar, and ${INTEGRATION_COUNT - 2} more. Set up in minutes.`,
    },
  },
  'online-courses': {
    tag: 'Use Case — Online Courses',
    headline: 'Teach the world.\nPrice it fairly.',
    subline: 'Your course can change lives anywhere in the world — but only if people can afford it. GoPayLocal adjusts your course pricing by purchasing power so students everywhere can learn from you.',
    secondaryCta: 'Read the Quickstart',
    problem: {
      title: 'Why course creators lose students',
      subtitle: `Your $199 course. With ${DEFAULT_SETTINGS}, this is what students pay with their code.`,
      columns: [
        { country: 'Without PPP', context: '$199 in every country', conversion: 'One price for all', positive: false },
        { country: 'USA', context: defaultDiscountLabel('US'), conversion: `${defaultPrice(199, 'US')}`, positive: true },
        { country: 'Mexico', context: defaultDiscountLabel('MX'), conversion: `${defaultPrice(199, 'MX')}`, positive: true },
        { country: 'Indonesia', context: defaultDiscountLabel('ID'), conversion: `${defaultPrice(199, 'ID')}`, positive: true },
      ],
    },
    features: {
      title: 'Built for course creators.',
      items: [
        { icon: 'graduation-cap', title: 'Payment Platforms', description: `Works with Stripe, Gumroad, Polar, Creem, WooCommerce and ${INTEGRATION_COUNT - 5} more. Teachable, Podia, Thinkific and Kajabi are not integrated.` },
        { icon: 'book-open', title: 'Cohort-Based Support', description: 'PPP pricing works for live cohorts, self-paced courses, and community memberships.' },
        { icon: 'shield', title: 'Student Verification', description: 'VPN detection prevents discount abuse: visitors on known VPN, Tor or datacenter networks get no discount.' },
        { icon: 'banknote', title: 'Multi-Currency Display', description: "For example, show ₹3,999 instead of $41.99 ($59.99 at 30% off, for a student in India, with Round to X9 charm pricing). Local prices are estimates at the day's exchange rate." },
        { icon: 'bar-chart-2', title: 'Test Your Pricing', description: 'A/B test two discount campaigns for a course and compare impressions, copies and redemptions side by side.' },
        { icon: 'trending-up', title: 'Enrollment Analytics', description: 'Track which countries enroll, which pricing converts, and where to promote your next course.' },
      ],
    },
    proof: {
      label: 'Why PPP works for online courses',
      description: 'Course audiences skew global, and full US tuition is out of reach for many students elsewhere. Local pricing gives them a price they can pay, and an A/B test of two discount levels shows which one gets more redemptions.',
    },
    cta: {
      title: "Every student who can't afford\nyour course is a missed opportunity.",
      subtitle: `Free to try. Works with Stripe, Gumroad, Polar, and ${INTEGRATION_COUNT - 3} more. Set up in minutes.`,
    },
  },
  'developer-tools': {
    tag: 'Use Case — Developer Tools',
    headline: 'Developers are global.\nYour pricing should be too.',
    subline: "The best developer tools have users worldwide — but US-only pricing locks out talented developers in emerging markets. Fair pricing builds a bigger community and drives long-term adoption.",
    secondaryCta: 'Read the Quickstart',
    problem: {
      title: 'The dev tool pricing gap',
      subtitle: `Your $19/mo pro plan. With ${DEFAULT_SETTINGS}, this is what developers pay with their code.`,
      columns: [
        { country: 'Without PPP', context: '$19/mo in every country', conversion: 'One price for all', positive: false },
        { country: 'USA', context: defaultDiscountLabel('US'), conversion: `${defaultPrice(19, 'US')}/mo`, positive: true },
        { country: 'Poland', context: defaultDiscountLabel('PL'), conversion: `${defaultPrice(19, 'PL')}/mo`, positive: true },
        { country: 'India', context: defaultDiscountLabel('IN'), conversion: `${defaultPrice(19, 'IN')}/mo`, positive: true },
      ],
    },
    features: {
      title: 'Built for developer tool companies.',
      items: [
        { icon: 'terminal', title: 'TypeScript SDKs', description: "Typed JavaScript and React SDKs give you the visitor's country, discount and code for your own pricing page and checkout." },
        { icon: 'git-branch', title: 'Open Source Friendly', description: 'Offer PPP on pro tiers while keeping open-source free. Build community trust and upsell fairly.' },
        { icon: 'users', title: 'Team Seat Pricing', description: "PPP adjusts per-seat pricing so global teams don't overpay. Works with team plans and enterprise tiers." },
        { icon: 'shield', title: 'VPN-Aware Discounts', description: 'Developers love VPNs. Visitors on known VPN, Tor and datacenter networks see your normal price, so the discount goes to people browsing from where they live.' },
        { icon: 'webhook', title: 'Redemption Tracking', description: "Redemptions arrive through your payment platform's webhooks, so you can see which countries actually buy." },
        { icon: 'trending-up', title: 'Developer Analytics', description: 'Track impressions, code copies and redemptions by country, and compare two discount campaigns with an A/B test.' },
      ],
    },
    proof: {
      label: 'Why PPP works for developer tools',
      description: 'Developer communities are heavily non-US. A fair local price on your pro plan converts engineers who love the tool but can\'t justify US pricing — and open, auditable VPN detection means the discount reaches real local devs, not VPN users.',
    },
    cta: {
      title: "Your best users are free users\nwho can't afford to go Pro.",
      subtitle: 'Free to try. Open source. TypeScript SDKs included. Set up in minutes.',
    },
  },
};
