export interface NavItem {
  label: string;
  href: string;
  group: 'Análise' | 'Dados' | 'Conta';
}

/** Navegação do dashboard — uma entrada por área de produto (PRD §17). */
export const NAV: NavItem[] = [
  { group: 'Análise', label: 'Overview', href: '/overview' },
  { group: 'Análise', label: 'Funis', href: '/funnels' },
  { group: 'Análise', label: 'Dashboards', href: '/dashboards' },
  { group: 'Análise', label: 'Attribution', href: '/attribution' },
  { group: 'Análise', label: 'Criativos', href: '/creatives' },
  { group: 'Análise', label: 'Data Explorer', href: '/explorer' },
  { group: 'Análise', label: 'AI Journey', href: '/ai' },
  { group: 'Análise', label: 'Perfis (User 360)', href: '/profiles' },
  { group: 'Dados', label: 'Tracking', href: '/tracking' },
  { group: 'Dados', label: 'Integrações', href: '/integrations' },
  { group: 'Dados', label: 'Qualidade de Dados', href: '/data-quality' },
  { group: 'Dados', label: 'Relatórios', href: '/reports' },
  { group: 'Conta', label: 'Configurações', href: '/settings' },
  { group: 'Conta', label: 'Billing', href: '/billing' },
];

export const NAV_GROUPS = ['Análise', 'Dados', 'Conta'] as const;
