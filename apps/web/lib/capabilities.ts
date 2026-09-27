import {
  Activity,
  Layers,
  Compass,
  TrendingUp,
  Image,
  Search,
  Brain,
  Users,
  ShieldCheck,
  FileText,
  Code2,
  Blocks,
  CreditCard,
  Radar,
  Target,
  Settings,
  GraduationCap,
  type LucideIcon,
} from 'lucide-react';

export type FeatureId =
  | 'overview'
  | 'opportunities'
  | 'radars'
  | 'customers'
  | 'integrations'
  | 'settings'
  | 'onboarding'
  | 'funnels'
  | 'funnel-builder'
  | 'attribution'
  | 'creatives'
  | 'explorer'
  | 'ai'
  | 'data-quality'
  | 'reports'
  | 'tracking'
  | 'billing';

export interface FeatureDefinition {
  id: FeatureId;
  name: string;
  route: string;
  icon: LucideIcon;
  enabled: boolean;
  navVisible: boolean;
  badge?: string | null;
  description: string;
}

export const FEATURE_REGISTRY: Record<FeatureId, FeatureDefinition> = {
  overview: {
    id: 'overview',
    name: 'Overview',
    route: '/app',
    icon: Activity,
    enabled: true,
    navVisible: true,
    badge: null,
    description: 'Painel de inteligência e KPIs de receita em tempo real.',
  },
  opportunities: {
    id: 'opportunities',
    name: 'Revenue Opportunities',
    route: '/app/opportunities',
    icon: Target,
    enabled: true,
    navVisible: true,
    badge: 'NOVO',
    description: 'Oportunidades acionáveis geradas pelos modelos de propensão.',
  },
  radars: {
    id: 'radars',
    name: 'Radars',
    route: '/app/radars',
    icon: Radar,
    enabled: true,
    navVisible: true,
    badge: 'NOVO',
    description: 'Perguntas de previsão configuradas para quem vai comprar a seguir.',
  },
  customers: {
    id: 'customers',
    name: 'Customer 360',
    route: '/app/customers',
    icon: Users,
    enabled: true,
    navVisible: true,
    badge: null,
    description: 'Visão unificada de clientes, histórico de identidade e eventos.',
  },
  integrations: {
    id: 'integrations',
    name: 'Integrations Hub',
    route: '/app/integrations',
    icon: Blocks,
    enabled: true,
    navVisible: true,
    badge: null,
    description: 'Central de fontes de dados e conectores de destino.',
  },
  settings: {
    id: 'settings',
    name: 'Settings',
    route: '/app/settings',
    icon: Settings,
    enabled: true,
    navVisible: true,
    badge: null,
    description: 'Configurações de workspace, perfil e políticas.',
  },
  onboarding: {
    id: 'onboarding',
    name: 'Onboarding Wizard',
    route: '/app/onboarding',
    icon: GraduationCap,
    enabled: true,
    navVisible: false,
    badge: null,
    description: 'Fluxo guiado de configuração inicial do workspace.',
  },
  // Módulos futuros/incompletos (desabilitados no MVP conforme SPEC-17)
  funnels: {
    id: 'funnels',
    name: 'Marketing Funnels',
    route: '/app/funnels',
    icon: Layers,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Análise de funis de conversão em múltiplos estágios.',
  },
  'funnel-builder': {
    id: 'funnel-builder',
    name: 'Funnel Builder',
    route: '/app/funnels/builder',
    icon: Compass,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Construtor visual de funis e jornadas.',
  },
  attribution: {
    id: 'attribution',
    name: 'Attribution Analyzer',
    route: '/app/attribution',
    icon: TrendingUp,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Modelagem de atribuição multitoque.',
  },
  creatives: {
    id: 'creatives',
    name: 'Creative Analytics',
    route: '/app/creatives',
    icon: Image,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Desempenho criativo e comparativo de anúncios.',
  },
  explorer: {
    id: 'explorer',
    name: 'Data Explorer',
    route: '/app/explorer',
    icon: Search,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Explorador de dados brutos e consultas personalizadas.',
  },
  ai: {
    id: 'ai',
    name: 'AI Journeys',
    route: '/app/ai',
    icon: Brain,
    enabled: false,
    navVisible: false,
    badge: 'IA',
    description: 'Automação inteligente de jornadas de cliente.',
  },
  'data-quality': {
    id: 'data-quality',
    name: 'Data Quality',
    route: '/app/data-quality',
    icon: ShieldCheck,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Monitoramento de qualidade de dados e reconciliação.',
  },
  reports: {
    id: 'reports',
    name: 'Reports',
    route: '/app/reports',
    icon: FileText,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Relatórios agendados e exportações automatizadas.',
  },
  tracking: {
    id: 'tracking',
    name: 'SDK & Pixel',
    route: '/app/tracking',
    icon: Code2,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Configuração do pixel cliente e chaves de API.',
  },
  billing: {
    id: 'billing',
    name: 'Billing & Plans',
    route: '/app/billing',
    icon: CreditCard,
    enabled: false,
    navVisible: false,
    badge: null,
    description: 'Gestão de assinatura e consumo de dados.',
  },
};

/** Retorna os itens de navegação visíveis no menu principal do MVP. */
export function getPrimaryNavItems(): FeatureDefinition[] {
  return Object.values(FEATURE_REGISTRY).filter((f) => f.enabled && f.navVisible);
}

/** Verifica se uma rota está habilitada no mapa central de capabilities. */
export function isRouteEnabled(pathname: string): boolean {
  const normalized = pathname.replace(/\/$/, '') || '/app';

  // 1. Overview exato
  if (normalized === '/app' || normalized === '/') {
    return true;
  }

  // 2. Rotas dinâmicas canônicas
  if (
    normalized === '/app/onboarding' ||
    normalized === '/app/integrations' ||
    normalized === '/app/radars' ||
    normalized.startsWith('/app/radars/') ||
    normalized === '/app/opportunities' ||
    normalized === '/app/customers' ||
    normalized.startsWith('/app/customers/') ||
    normalized === '/app/settings'
  ) {
    return true;
  }

  // 3. Procura feature específica (exceto overview)
  const match = Object.values(FEATURE_REGISTRY).find(
    (f) =>
      f.id !== 'overview' &&
      (f.route === normalized || normalized.startsWith(`${f.route}/`)),
  );
  return match ? match.enabled : false;
}
