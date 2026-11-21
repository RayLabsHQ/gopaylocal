import {
  Globe, Shield, TrendingUp, Banknote, Sparkles, Zap,
  Cloud, Terminal, Webhook, Code, Package, GitBranch,
  MapPin, ShieldCheck, BarChart2, Coins, Brain, Link,
  Repeat, Users, CreditCard, Activity,
  Download, ShoppingBag, Palette,
  GraduationCap, BookOpen, MessageCircle,
  type LucideIcon,
} from 'lucide-react';

const iconMap: Record<string, LucideIcon> = {
  globe: Globe,
  shield: Shield,
  'shield-check': ShieldCheck,
  'trending-up': TrendingUp,
  banknote: Banknote,
  sparkles: Sparkles,
  zap: Zap,
  cloud: Cloud,
  terminal: Terminal,
  webhook: Webhook,
  code: Code,
  package: Package,
  'git-branch': GitBranch,
  'map-pin': MapPin,
  'bar-chart-2': BarChart2,
  coins: Coins,
  brain: Brain,
  link: Link,
  repeat: Repeat,
  users: Users,
  'credit-card': CreditCard,
  activity: Activity,
  download: Download,
  'shopping-bag': ShoppingBag,
  palette: Palette,
  'graduation-cap': GraduationCap,
  'book-open': BookOpen,
  'message-circle': MessageCircle,
};

interface FeatureIconProps {
  name: string;
  className?: string;
}

export function FeatureIcon({ name, className = 'h-5 w-5' }: FeatureIconProps) {
  const Icon = iconMap[name] || Globe;
  return <Icon className={className} />;
}
