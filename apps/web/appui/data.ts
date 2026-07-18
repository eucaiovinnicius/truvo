import { Funnel, CampaignRow, Integration, ApiKey } from './types';

export const initialFunnels: Funnel[] = [
  {
    id: 'ecommerce-main',
    name: 'E-commerce Main Journey',
    status: 'active',
    conversionRate: 3.2,
    totalSteps: 4,
    updatedTime: 'Updated 2h ago',
    sparklineData: [35, 30, 32, 10, 25, 5, 15],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        name: 'Ad Click',
        eventType: 'page_view',
        conditions: [
          { id: 'c-1', field: 'utm_medium', operator: 'equals', value: 'cpc' }
        ],
        reach: 100000
      },
      {
        id: 'step-2',
        stepNumber: 2,
        name: 'Landing Page',
        eventType: 'view_item',
        conditions: [],
        reach: 45000
      },
      {
        id: 'step-3',
        stepNumber: 3,
        name: 'Add to Cart',
        eventType: 'add_to_cart',
        conditions: [],
        reach: 12000
      },
      {
        id: 'step-4',
        stepNumber: 4,
        name: 'Purchase',
        eventType: 'purchase',
        conditions: [],
        reach: 3500
      }
    ]
  },
  {
    id: 'saas-onboarding',
    name: 'SaaS Onboarding Flow',
    status: 'active',
    conversionRate: 12.8,
    totalSteps: 6,
    updatedTime: 'Updated 5m ago',
    sparklineData: [10, 15, 12, 30, 5, 25, 8],
    steps: [
      { id: 's1', stepNumber: 1, name: 'Sign Up Visit', eventType: 'page_view', conditions: [], reach: 50000 },
      { id: 's2', stepNumber: 2, name: 'Form Filled', eventType: 'lead', conditions: [], reach: 25000 },
      { id: 's3', stepNumber: 3, name: 'Email Verified', eventType: 'custom_event', conditions: [], reach: 18000 },
      { id: 's4', stepNumber: 4, name: 'Profile Completed', eventType: 'custom_event', conditions: [], reach: 12000 },
      { id: 's5', stepNumber: 5, name: 'Invite Team', eventType: 'custom_event', conditions: [], reach: 8000 },
      { id: 's6', stepNumber: 6, name: 'Subscription Active', eventType: 'purchase', conditions: [], reach: 6400 }
    ]
  },
  {
    id: 'summer-sale',
    name: 'Summer Sale Landing',
    status: 'inactive',
    conversionRate: 0.0,
    totalSteps: 3,
    updatedTime: 'Paused 12d ago',
    sparklineData: [38, 38, 38, 38, 38, 38, 38],
    steps: [
      { id: 's-sale-1', stepNumber: 1, name: 'Ad Click', eventType: 'page_view', conditions: [], reach: 15000 },
      { id: 's-sale-2', stepNumber: 2, name: 'Product Click', eventType: 'view_item', conditions: [], reach: 3200 },
      { id: 's-sale-3', stepNumber: 3, name: 'Checkout Complete', eventType: 'purchase', conditions: [], reach: 0 }
    ]
  },
  {
    id: 'newsletter-sub',
    name: 'Newsletter Subscription',
    status: 'active',
    conversionRate: 22.4,
    totalSteps: 2,
    updatedTime: 'Updated 1h ago',
    sparklineData: [25, 5, 15, 5, 12, 10, 8],
    steps: [
      { id: 'news-1', stepNumber: 1, name: 'Blog Reader', eventType: 'page_view', conditions: [], reach: 10000 },
      { id: 'news-2', stepNumber: 2, name: 'Subscribe Submitted', eventType: 'lead', conditions: [], reach: 2240 }
    ]
  },
  {
    id: 'q4-retention',
    name: 'Q4 Retention Campaign',
    status: 'draft',
    conversionRate: 0.0,
    totalSteps: 0,
    updatedTime: 'Created yesterday',
    sparklineData: [],
    steps: []
  }
];

export const initialIntegrations: Integration[] = [
  {
    id: 'meta-ads',
    name: 'Meta Ads',
    icon: 'Meta',
    status: 'syncing',
    details: "Connected to 'Truvo Global' Business Manager.",
    lastSync: 'Last sync: 2m ago'
  },
  {
    id: 'google-ads',
    name: 'Google Ads',
    icon: 'Google',
    status: 'syncing',
    details: 'Connected to MCC ID: 893-112-4452.',
    lastSync: 'Last sync: 5m ago'
  },
  {
    id: 'tiktok-ads',
    name: 'TikTok For Business',
    icon: 'TikTok',
    status: 'auth_error',
    details: 'OAuth token expired. Re-authentication required.',
    lastSync: 'Failed: 2h ago'
  },
  {
    id: 'shopify-app',
    name: 'Shopify',
    icon: 'Shopify',
    status: 'connected',
    details: 'Server-side purchase event routing active.',
    lastSync: 'Real-time Webhook'
  }
];

export const initialCampaigns: CampaignRow[] = [
  {
    id: 'camp-1',
    name: 'TBT - CostCap',
    status: 'active',
    spend: 12.71,
    rcas: 2.69,
    roas_reported: 0.00,
    roas_model: 3.08,
    orders: 1,
    cv: 39.20,
    cpa: 12.71,
    aov: 39.20,
    ncRoas: 3.08,
    atc: 1,
    catc: 12.71
  },
  {
    id: 'camp-2',
    name: 'TBT Customer List - Cross Sell',
    status: 'inactive',
    spend: 99.82,
    rcas: 0.63,
    roas_reported: 0.00,
    roas_model: 0.73,
    orders: 2,
    cv: 73.00,
    cpa: 49.91,
    aov: 36.50,
    ncRoas: 0.00,
    atc: 0,
    catc: 0.00
  },
  {
    id: 'camp-3',
    name: 'TBT - Prospecting - Quiz',
    status: 'active',
    spend: 145.92,
    rcas: 1.94,
    roas_reported: 0.00,
    roas_model: 0.91,
    orders: 3,
    cv: 132.40,
    cpa: 48.64,
    aov: 44.13,
    ncRoas: 0.91,
    atc: 0,
    catc: 0.00
  },
  {
    id: 'camp-4',
    name: 'FEEDS - US - F - 25-55 - Purchase LLA',
    status: 'active',
    spend: 97.31,
    rcas: 0.97,
    roas_reported: 0.54,
    roas_model: 1.02,
    orders: 2,
    cv: 99.00,
    cpa: 48.66,
    aov: 49.50,
    ncRoas: 1.02,
    atc: 0,
    catc: 0.00,
    isExpanded: true,
    childRows: [
      {
        id: 'camp-4-sub-1',
        name: 'Ad Set 1',
        status: 'active',
        spend: 50.00,
        rcas: 1.00,
        roas_reported: 0.50,
        roas_model: 1.10,
        orders: 1,
        cv: 50.00,
        cpa: 50.00,
        aov: 50.00,
        ncRoas: 1.10,
        atc: 0,
        catc: 0.00
      }
    ]
  },
  {
    id: 'camp-5',
    name: 'FEEDS - US - F - 25-55 - Beauty',
    status: 'active',
    spend: 193.95,
    rcas: 0.59,
    roas_reported: 0.95,
    roas_model: 2.41,
    orders: 10,
    cv: 467.00,
    cpa: 19.40,
    aov: 46.70,
    ncRoas: 2.19,
    atc: 0,
    catc: 0.00
  },
  {
    id: 'camp-6',
    name: 'TBT Kit - Interest Testing (NEW)',
    status: 'active',
    spend: 1216.17,
    rcas: 1.86,
    roas_reported: 0.00,
    roas_model: 2.71,
    orders: 73,
    cv: 3295.70,
    cpa: 16.66,
    aov: 45.16,
    ncRoas: 2.65,
    atc: 7,
    catc: 173.74
  }
];

export const initialApiKeys: ApiKey[] = [
  {
    id: 'key-1',
    name: 'Production Environment',
    key: 'pk_live_68798e98b7a9f2',
    status: 'active'
  },
  {
    id: 'key-2',
    name: 'Staging Key (Legacy)',
    key: 'pk_test_12498db257b8c1',
    status: 'inactive'
  }
];
