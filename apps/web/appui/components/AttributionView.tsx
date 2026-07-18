'use client';

import React, { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  Info, 
  Sliders, 
  ChevronRight, 
  ChevronDown, 
  CheckCircle, 
  AlertCircle,
  HelpCircle,
  Sparkles,
  RefreshCw,
  Power,
  BarChart2,
  Download,
  X,
  PlaySquare,
  Tag,
  ArrowLeft,
  Folder,
  ArrowUpRight
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip 
} from 'recharts';
import { CampaignRow } from '../types';

interface AttributionViewProps {
  campaigns: CampaignRow[];
  setCampaigns: React.Dispatch<React.SetStateAction<CampaignRow[]>>;
  dateRange: string;
}

export default function AttributionView({ 
  campaigns, 
  setCampaigns, 
  dateRange 
}: AttributionViewProps) {
  const [selectedModel, setSelectedModel] = useState<'first' | 'last' | 'linear' | 'position' | 'truvo_ai'>('truvo_ai');
  const [lookbackWindow, setLookbackWindow] = useState<1 | 7 | 30 | 90>(30);
  const [expandedCampaigns, setExpandedCampaigns] = useState<Record<string, boolean>>({
    'camp-4': true // expand Shopify LLA by default
  });
  const [expandedAdSets, setExpandedAdSets] = useState<Record<string, boolean>>({});
  const [selectedCreative, setSelectedCreative] = useState<any>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);

  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);
  const [expandedAdSet, setExpandedAdSet] = useState<string | null>(null);

  // Video progress animation simulator for UGC ad player mockup
  useEffect(() => {
    let interval: any;
    if (isPlaying) {
      interval = setInterval(() => {
        setVideoProgress((p) => {
          if (p >= 100) {
            return 0; // loop
          }
          return p + 1.2;
        });
      }, 50);
    } else {
      clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [isPlaying]);

  interface FunnelChannelPerformance {
    channel: string;
    spend: number;
    visitors: number;
    conversions: number;
    convRate: number;
    cpa: number;
    reportedRoas: number;
    modelRoas: number;
  }

  interface CreativePerformance {
    content: string;
    spend: number;
    visitors: number;
    conversions: number;
    convRate: number;
    cpa: number;
    reportedRoas: number;
    modelRoas: number;
  }

  interface AdSetPerformance {
    term: string;
    spend: number;
    visitors: number;
    conversions: number;
    convRate: number;
    cpa: number;
    reportedRoas: number;
    modelRoas: number;
    creatives: CreativePerformance[];
  }

  interface CampaignPerformance {
    utm_campaign: string;
    spend: number;
    visitors: number;
    conversions: number;
    convRate: number;
    cpa: number;
    reportedRoas: number;
    modelRoas: number;
    adSets: AdSetPerformance[];
  }

  function getChannelData(model: string): FunnelChannelPerformance[] {
    const activeModel = model === 'truvo_ai' ? 'truvo_ml' :
                        model === 'first' ? 'first_click' :
                        model === 'last' ? 'last_click' :
                        'linear';

    if (activeModel === 'truvo_ml') {
      return [
        { channel: 'Meta Ads', spend: 45000, visitors: 45000, conversions: 1512, convRate: 3.4, cpa: 29.76, reportedRoas: 1.85, modelRoas: 2.75 },
        { channel: 'Google Search', spend: 28000, visitors: 25000, conversions: 1120, convRate: 4.5, cpa: 25.00, reportedRoas: 2.90, modelRoas: 3.45 },
        { channel: 'TikTok Ads', spend: 18000, visitors: 20000, conversions: 420, convRate: 2.1, cpa: 42.85, reportedRoas: 1.10, modelRoas: 1.85 },
        { channel: 'Email / Klaviyo', spend: 1500, visitors: 5000, conversions: 348, convRate: 6.9, cpa: 4.31, reportedRoas: 12.50, modelRoas: 15.20 },
        { channel: 'Direct / Organic', spend: 0, visitors: 5000, conversions: 100, convRate: 2.0, cpa: 0, reportedRoas: 0, modelRoas: 0 }
      ];
    } else if (activeModel === 'first_click') {
      return [
        { channel: 'Meta Ads', spend: 45000, visitors: 45000, conversions: 1820, convRate: 4.0, cpa: 24.72, reportedRoas: 1.85, modelRoas: 3.31 },
        { channel: 'Google Search', spend: 28000, visitors: 25000, conversions: 810, convRate: 3.2, cpa: 34.56, reportedRoas: 2.90, modelRoas: 2.50 },
        { channel: 'TikTok Ads', spend: 18000, visitors: 20000, conversions: 590, convRate: 2.9, cpa: 30.50, reportedRoas: 1.10, modelRoas: 2.60 },
        { channel: 'Email / Klaviyo', spend: 1500, visitors: 5000, conversions: 120, convRate: 2.4, cpa: 12.50, reportedRoas: 12.50, modelRoas: 5.24 },
        { channel: 'Direct / Organic', spend: 0, visitors: 5000, conversions: 160, convRate: 3.2, cpa: 0, reportedRoas: 0, modelRoas: 0 }
      ];
    } else if (activeModel === 'last_click') {
      return [
        { channel: 'Meta Ads', spend: 45000, visitors: 45000, conversions: 980, convRate: 2.2, cpa: 45.91, reportedRoas: 1.85, modelRoas: 1.78 },
        { channel: 'Google Search', spend: 28000, visitors: 25000, conversions: 1450, convRate: 5.8, cpa: 19.31, reportedRoas: 2.90, modelRoas: 4.48 },
        { channel: 'TikTok Ads', spend: 18000, visitors: 20000, conversions: 210, convRate: 1.0, cpa: 85.71, reportedRoas: 1.10, modelRoas: 0.92 },
        { channel: 'Email / Klaviyo', spend: 1500, visitors: 5000, conversions: 720, convRate: 14.4, cpa: 2.08, reportedRoas: 12.50, modelRoas: 31.40 },
        { channel: 'Direct / Organic', spend: 0, visitors: 5000, conversions: 140, convRate: 2.8, cpa: 0, reportedRoas: 0, modelRoas: 0 }
      ];
    } else { // linear or position
      return [
        { channel: 'Meta Ads', spend: 45000, visitors: 45000, conversions: 1300, convRate: 2.9, cpa: 34.61, reportedRoas: 1.85, modelRoas: 2.36 },
        { channel: 'Google Search', spend: 28000, visitors: 25000, conversions: 1120, convRate: 4.5, cpa: 25.00, reportedRoas: 2.90, modelRoas: 3.45 },
        { channel: 'TikTok Ads', spend: 18000, visitors: 20000, conversions: 410, convRate: 2.0, cpa: 43.90, reportedRoas: 1.10, modelRoas: 1.80 },
        { channel: 'Email / Klaviyo', spend: 1500, visitors: 5000, conversions: 430, convRate: 8.6, cpa: 3.48, reportedRoas: 12.50, modelRoas: 18.70 },
        { channel: 'Direct / Organic', spend: 0, visitors: 5000, conversions: 240, convRate: 4.8, cpa: 0, reportedRoas: 0, modelRoas: 0 }
      ];
    }
  }

  function getCampaignData(channelName: string, parent: FunnelChannelPerformance): CampaignPerformance[] {
    let campaignNames: string[] = [];
    let adSetNamesGroup: string[][] = [];
    let creativeNamesGroup: string[][][] = [];

    if (channelName.includes('Meta Ads')) {
      campaignNames = [
        '[FB-CONV] Conversão - Coleção de Inverno',
        '[FB-LOOK] Prospecting - Lookalike Compra 1%',
        '[FB-RETRG] Remarketing - Checkout Abandono 14d'
      ];
      adSetNamesGroup = [
        ['[AS-INTEREST] Interesses Moda e Vestuário', '[AS-BROAD] Sem Interesses - Público Aberto'],
        ['[AS-LAL] Lookalike Compradores 1-3%', '[AS-LAL] Lookalike Engajados Instagram 5%'],
        ['[AS-CUSTOM] Abandono de Carrinho 7d', '[AS-CUSTOM] Visualizou Produto 14d']
      ];
      creativeNamesGroup = [
        [
          ['[AD-V01] Vídeo UGC Depoimento Cliente', '[AD-I02] Foto Grid Look de Inverno'],
          ['[AD-I03] Carrossel Dinâmico de Produtos', '[AD-V04] Unboxing de Inverno']
        ],
        [
          ['[AD-V01] Vídeo UGC Depoimento Cliente', '[AD-I04] Imagem Única Desconto 10%'],
          ['[AD-I03] Carrossel Dinâmico de Produtos', '[AD-V02] Benefícios Frete Grátis']
        ],
        [
          ['[AD-I05] Cupom Exclusivo: QUERO10', '[AD-V05] Vídeo Urgência Últimas Peças'],
          ['[AD-I06] Carrossel Abandono de Carrinho', '[AD-V06] Tutorial de Finalização de Compra']
        ]
      ];
    } else if (channelName.includes('Google Search') || channelName.includes('Google Ads')) {
      campaignNames = [
        '[GS-BRAND] Institucional - Palavras de Marca',
        '[GS-GENERIC] Categoria - Atribuição Inteligente',
        '[GS-COMP] Concorrentes - Alternativas de Atribuição'
      ];
      adSetNamesGroup = [
        ['[AS-BRAND-EXACT] Marca Exata', '[AS-BRAND-PHRASE] Marca Frase'],
        ['[AS-GENERIC-EXACT] Atribuição de Marketing', '[AS-GENERIC-BROAD] Modelagem ROAS'],
        ['[AS-COMP-EXACT] Alternativas Shopify Pixel', '[AS-COMP-PHRASE] Concorrentes Diretos']
      ];
      creativeNamesGroup = [
        [
          ['[AD-T01] Título: Truvo Analytics® | Atribuição Sem Cookies', '[AD-T02] Título: Truvo® - Rastreamento Integrado'],
          ['[AD-T03] Título: Truvo Analytics® | Teste Grátis 14d', '[AD-T04] Título: Truvo® - Descubra o ROAS Real']
        ],
        [
          ['[AD-T05] Título: Atribuição Multi-Touch Avançada', '[AD-T06] Título: Como Corrigir o iOS 14 - Truvo'],
          ['[AD-T07] Título: Plataforma de Atribuição - Truvo', '[AD-T08] Título: Melhore seu ROAS em até 30%']
        ],
        [
          ['[AD-T09] Título: Migre para o Truvo | Atribuição Real', '[AD-T10] Título: Melhor que o Pixel Padrão'],
          ['[AD-T11] Título: Atribuição Sem Perda de Dados', '[AD-T12] Título: Dashboard Multi-Canal Truvo']
        ]
      ];
    } else if (channelName.includes('TikTok Ads')) {
      campaignNames = [
        '[TT-TREND] Trend Viral Challenge',
        '[TT-PROSP] Prospecting Spark Ads'
      ];
      adSetNamesGroup = [
        ['[AS-TT-ENG] Engajamento Vídeos - Público 18-34', '[AS-TT-HAST] Hashtags Relacionadas - Ecom'],
        ['[AS-TT-INTEREST] Interesses Compras Online', '[AS-TT-BROAD] Aberto Brasil']
      ];
      creativeNamesGroup = [
        [
          ['[AD-TTV01] Vídeo Trend Dança - Demo Painel', '[AD-TTV02] React de Criador com Truvo'],
          ['[AD-TTV03] Transição Rápida Funcionalidades', '[AD-TTV04] ASMR Mostrando Envio']
        ],
        [
          ['[AD-TTV05] Vídeo UGC: Como configurei em 5 min', '[AD-TTV06] Truvo vs Soluções Caseiras'],
          ['[AD-TTV07] Anúncio Direto - Oferta Especial', '[AD-TTV08] Review de Loja de Sucesso']
        ]
      ];
    } else if (channelName.includes('LinkedIn Ads')) {
      campaignNames = [
        '[LI-ABM] ABM - Diretores de Marketing (SaaS)',
        '[LI-EBOOK] Lead Gen - Ebook Atribuição Avançada'
      ];
      adSetNamesGroup = [
        ['[AS-LI-DIR] Diretores & Head de Growth - Empresas 50+', '[AS-LI-CMO] CMOs & VP of Marketing - Varejo'],
        ['[AS-LI-MO] Marketing Ops & Analistas', '[AS-LI-GROWTH] Growth Hackers & Co-Founders']
      ];
      creativeNamesGroup = [
        [
          ['[AD-LIP01] Post: Infográfico de Atribuição Truvo', '[AD-LIP02] Carrossel: Como Corrigir o iOS 14'],
          ['[AD-LIP03] Vídeo: Demo do Dashboard Truvo', '[AD-LIP04] Depoimento de CMO de Unicórnio']
        ],
        [
          ['[AD-LIP05] Baixar Ebook: Guia Prático de ROAS', '[AD-LIP06] Checklist de Setup de Rastreamento'],
          ['[AD-LIP07] Ebook: Atribuição Omnichannel 2026', '[AD-LIP08] Webinar Gravado: Escala de Mídia']
        ]
      ];
    } else if (channelName.includes('Email') || channelName.includes('Newsletter')) {
      campaignNames = [
        '[KL-FLOW] Welcome Flow - Leads Registrados',
        '[KL-RECOVERY] Abandono de Checkout Recuperado'
      ];
      adSetNamesGroup = [
        ['[AS-KL-ACTIVE] Engajados 30 Dias', '[AS-KL-NEW] Novos Cadastros'],
        ['[AS-KL-CART] Abandono com Ticket Alto', '[AS-KL-CART-LOW] Abandono Ticket Baixo']
      ];
      creativeNamesGroup = [
        [
          ['[AD-KL-E01] Email: Bem-vindo à Truvo! Seu cupom chegou', '[AD-KL-E02] Email: Conheça nossos bastidores'],
          ['[AD-KL-E03] Email: Como funciona o Truvo AI Graph', '[AD-KL-E04] Email: O que nossos clientes dizem']
        ],
        [
          ['[AD-KL-E05] Email: Esqueceu algo? Frete Grátis liberado', '[AD-KL-E06] Email: Seu carrinho expira em 2 horas'],
          ['[AD-KL-E07] Email: Finalize com 10% OFF', '[AD-KL-E08] Email: Dúvidas sobre o produto? Fale conosco']
        ]
      ];
    } else {
      campaignNames = [
        '[ORG-SEO] Blog Posts - Artigos Técnicos',
        '[ORG-DIRECT] Acesso Direto à Home'
      ];
      adSetNamesGroup = [
        ['[AS-ORG-SEO] Palavras-chave de Cauda Longa', '[AS-ORG-IND] Indicações de Redes Sociais'],
        ['[AS-ORG-DIR] Acesso Direto / Favoritos', '[AS-ORG-REF] Domínio de Referência']
      ];
      creativeNamesGroup = [
        [
          ['[AD-ORG-C01] Artigo: O que é Atribuição Multi-Touch', '[AD-ORG-C02] Artigo: Por que o GA4 Erra seu ROAS'],
          ['[AD-ORG-C03] Post Orgânico LinkedIn', '[AD-ORG-C04] Post Orgânico Twitter/X']
        ],
        [
          ['[AD-ORG-C05] Visita Direta / URL Digitada', '[AD-ORG-C06] Bookmark do Navegador'],
          ['[AD-ORG-C07] Link em Apresentação Institucional', '[AD-ORG-C08] Referência em Comunidade']
        ]
      ];
    }

    const campaignRatios = campaignNames.length === 3 ? [0.55, 0.30, 0.15] : [0.70, 0.30];
    
    return campaignRatios.map((cRatio, cIdx) => {
      const cName = campaignNames[cIdx];
      const cSpend = Math.round(parent.spend * cRatio);
      const cVisitors = Math.round(parent.visitors * cRatio);
      
      const conversionVariation = cIdx === 0 ? 1.15 : cIdx === 1 ? 0.90 : 0.60;
      const cConversions = Math.round(parent.conversions * cRatio * conversionVariation);
      
      const cConvRate = cVisitors > 0 ? Number(((cConversions / cVisitors) * 100).toFixed(1)) : 0;
      const cCpa = cConversions > 0 ? Number((cSpend / cConversions).toFixed(2)) : 0;
      
      const cReportedRoas = parent.reportedRoas > 0 ? Number((parent.reportedRoas * conversionVariation).toFixed(2)) : 0;
      const cModelRoas = parent.modelRoas > 0 ? Number((parent.modelRoas * conversionVariation).toFixed(2)) : 0;

      const adSetRatios = [0.65, 0.35];
      const adSets: AdSetPerformance[] = adSetRatios.map((asRatio, asIdx) => {
        const asName = adSetNamesGroup[cIdx]?.[asIdx] || `[AS] Conjunto de Anúncios #${asIdx + 1}`;
        const asSpend = Math.round(cSpend * asRatio);
        const asVisitors = Math.round(cVisitors * asRatio);
        
        const asVariation = asIdx === 0 ? 1.10 : 0.81;
        const asConversions = Math.round(cConversions * asRatio * asVariation);
        
        const asConvRate = asVisitors > 0 ? Number(((asConversions / asVisitors) * 100).toFixed(1)) : 0;
        const asCpa = asConversions > 0 ? Number((asSpend / asConversions).toFixed(2)) : 0;
        
        const asReportedRoas = cReportedRoas > 0 ? Number((cReportedRoas * asVariation).toFixed(2)) : 0;
        const asModelRoas = cModelRoas > 0 ? Number((cModelRoas * asVariation).toFixed(2)) : 0;

        const creativeRatios = [0.60, 0.40];
        const creatives: CreativePerformance[] = creativeRatios.map((crRatio, crIdx) => {
          const crName = creativeNamesGroup[cIdx]?.[asIdx]?.[crIdx] || `[AD] Criativo #${crIdx + 1}`;
          const crSpend = Math.round(asSpend * crRatio);
          const crVisitors = Math.round(asVisitors * crRatio);
          
          const crVariation = crIdx === 0 ? 1.05 : 0.925;
          const crConversions = Math.round(asConversions * crRatio * crVariation);
          
          const crConvRate = crVisitors > 0 ? Number(((crConversions / crVisitors) * 100).toFixed(1)) : 0;
          const crCpa = crConversions > 0 ? Number((crSpend / crConversions).toFixed(2)) : 0;
          
          const crReportedRoas = asReportedRoas > 0 ? Number((asReportedRoas * crVariation).toFixed(2)) : 0;
          const crModelRoas = asModelRoas > 0 ? Number((asModelRoas * crVariation).toFixed(2)) : 0;

          return {
            content: crName,
            spend: crSpend,
            visitors: crVisitors,
            conversions: crConversions,
            convRate: crConvRate,
            cpa: crCpa,
            reportedRoas: crReportedRoas,
            modelRoas: crModelRoas
          };
        });

        return {
          term: asName,
          spend: asSpend,
          visitors: asVisitors,
          conversions: asConversions,
          convRate: asConvRate,
          cpa: asCpa,
          reportedRoas: asReportedRoas,
          modelRoas: asModelRoas,
          creatives
        };
      });

      return {
        utm_campaign: cName,
        spend: cSpend,
        visitors: cVisitors,
        conversions: cConversions,
        convRate: cConvRate,
        cpa: cCpa,
        reportedRoas: cReportedRoas,
        modelRoas: cModelRoas,
        adSets
      };
    });
  }

  const attributionModels = [
    { id: 'first', name: 'First Touch', description: 'Gives 100% credit to the initial click.' },
    { id: 'last', name: 'Last Touch', description: 'Gives 100% credit to the final click before order.' },
    { id: 'linear', name: 'Linear', description: 'Splits conversion credit equally across all touchpoints.' },
    { id: 'position', name: 'Position-Based', description: '40% first, 40% last, 20% distributed in middle.' },
    { id: 'truvo_ai', name: 'Truvo AI Multi-Touch', description: 'Machine learning graph modeling of click sequences.' }
  ];

  // Helper: Shift model ROAS values based on selected model to demonstrate interactivity
  const getModelMultiplier = (model: string, campaignId: string) => {
    // Custom seed-based pseudo random math to make individual campaigns react differently
    const campaignSeed = campaignId.charCodeAt(campaignId.length - 1) || 5;
    
    switch (model) {
      case 'first':
        return (campaignSeed % 3 === 0) ? 1.45 : 0.85;
      case 'last':
        return (campaignSeed % 2 === 0) ? 0.70 : 1.30;
      case 'linear':
        return 1.05;
      case 'position':
        return 1.15;
      case 'truvo_ai':
      default:
        return 1.35; // Truvo AI always uncovers hidden ROAS!
    }
  };

  const toggleExpandCampaign = (id: string) => {
    setExpandedCampaigns(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const handleToggleCampaignStatus = (id: string) => {
    setCampaigns(prev => prev.map(c => {
      if (c.id === id) {
        return { ...c, status: c.status === 'active' ? 'inactive' : 'active' };
      }
      return c;
    }));
  };

  // Touchpoint Frequency data for Recharts Histogram
  const touchpointData = [
    { name: '1 Touch', Percentage: 14, Sales: 240 },
    { name: '2-3 Touches', Percentage: 46, Sales: 785 },
    { name: '4-5 Touches', Percentage: 28, Sales: 476 },
    { name: '6+ Touches', Percentage: 12, Sales: 204 }
  ];

  return (
    <div id="attribution-view-container" className="space-y-6">
      {/* Overview Block */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Attribution Modeling Feed</h2>
          <p className="text-xs text-slate-500 mt-1 font-sans">Toggle attribution formulas to resolve API privacy signals and under-reported conversion data</p>
        </div>
        
        {/* Lookback window selection */}
        <div className="flex items-center gap-1.5 bg-slate-50 p-1 rounded-xl border border-slate-100 self-start">
          <span className="text-[10px] font-mono font-bold text-slate-400 uppercase px-2">Lookback:</span>
          {([1, 7, 30, 90] as const).map((win) => (
            <button
              key={win}
              onClick={() => setLookbackWindow(win)}
              className={`px-3 py-1 rounded-lg text-[10px] font-bold font-mono cursor-pointer transition-all ${
                lookbackWindow === win
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-600 hover:bg-slate-150'
              }`}
            >
              {win}D
            </button>
          ))}
        </div>
      </div>

      {/* Grid: Model Buttons on Left, Confidence on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Attribution Models Selection Pane - Span 8 */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs lg:col-span-8">
          <div className="flex items-center gap-2 mb-4">
            <Sliders className="w-4.5 h-4.5 text-teal-600" />
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Select Active Model</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
            {attributionModels.map((m) => {
              const isSelected = selectedModel === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setSelectedModel(m.id as any)}
                  className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-teal-50/55 border-teal-200 shadow-2xs'
                      : 'bg-white border-slate-100 hover:border-slate-200'
                  }`}
                >
                  <span className={`text-xs font-bold block ${isSelected ? 'text-teal-800' : 'text-slate-700'}`}>
                    {m.name}
                  </span>
                  <span className="text-[9px] text-slate-400 mt-1 block leading-normal">
                    {m.id === 'truvo_ai' ? '🤖 ML Sequence Graph' : 'Traditional'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-4 bg-slate-50 p-3 rounded-xl border border-slate-100/60 flex items-start gap-2 text-[11px] text-slate-600">
            <Info className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-slate-700 font-mono uppercase tracking-wide">Model Rule: </span>
              {attributionModels.find(m => m.id === selectedModel)?.description}
            </div>
          </div>
        </div>

        {/* Confidence Gauge Card - Span 4 */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs lg:col-span-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">Integrity Score</span>
              <Sparkles className="w-4 h-4 text-emerald-600" />
            </div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Attribution Confidence</h3>
            
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-3xl font-bold text-slate-900 font-mono tracking-tight">94.6%</span>
              <span className="text-emerald-600 font-bold text-xs font-mono">Excellent</span>
            </div>
          </div>

          <div className="mt-4 text-[10px] text-slate-500 leading-relaxed font-sans">
            Calculated from cookies, Shopify purchase webhook timestamps, and device fingerprints. High confidence indicates low signal-loss rates.
          </div>
        </div>
      </div>

      {/* Campaigns Comparison Table */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Campaign Attribution Comparer</h3>
            <p className="text-xs text-slate-500 mt-1">Cross-reports ad platform reported metrics side-by-side with your selected model</p>
          </div>
          <div className="text-xs font-mono bg-teal-50 border border-teal-100 text-teal-800 px-2.5 py-1 rounded-lg">
            Model Shifting Active: <b className="font-bold">{attributionModels.find(m => m.id === selectedModel)?.name}</b>
          </div>
        </div>

        {/* Navigation Breadcrumb */}
        {selectedChannel && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-100/80 mb-4">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 font-sans">
              <button 
                onClick={() => {
                  setSelectedChannel(null);
                  setExpandedCampaign(null);
                  setExpandedAdSet(null);
                }}
                className="text-slate-500 hover:text-teal-600 font-bold flex items-center gap-1 cursor-pointer transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Todos os Canais</span>
              </button>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="bg-teal-50 text-teal-800 font-bold px-2 py-0.5 rounded-md border border-teal-100/80 flex items-center gap-1 shrink-0">
                {selectedChannel}
              </span>
              {expandedCampaign && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="bg-indigo-50 text-indigo-800 font-bold px-2 py-0.5 rounded-md border border-indigo-100/80 flex items-center gap-1 shrink-0">
                    <Folder className="w-3 h-3 text-amber-500" />
                    <span>{expandedCampaign.replace(/\[.*?\]\s*/, '')}</span>
                  </span>
                </>
              )}
              {expandedAdSet && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="bg-pink-50 text-pink-800 font-bold px-2 py-0.5 rounded-md border border-pink-100/80 flex items-center gap-1 shrink-0">
                    <Tag className="w-3 h-3 text-indigo-500" />
                    <span>{expandedAdSet.replace(/\[.*?\]\s*/, '')}</span>
                  </span>
                </>
              )}
            </div>
            
            <button 
              onClick={() => {
                setSelectedChannel(null);
                setExpandedCampaign(null);
                setExpandedAdSet(null);
              }}
              className="text-[11px] font-bold text-slate-600 hover:text-slate-800 border border-slate-200 bg-white hover:bg-slate-50 px-3 py-1.5 rounded-lg cursor-pointer transition-colors self-start sm:self-auto shadow-2xs"
            >
              Voltar para Canais
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-3 font-semibold pl-2">
                  {selectedChannel ? 'Campanha / Conjunto / Criativo' : 'Canal'}
                </th>
                <th className="py-3 font-semibold text-right">Investimento</th>
                <th className="py-3 font-semibold text-right">Visitantes</th>
                <th className="py-3 font-semibold text-right">Conversões</th>
                <th className="py-3 font-semibold text-right">Taxa de Conversão</th>
                <th className="py-3 font-semibold text-right">CPA / CAC</th>
                <th className="py-3 font-semibold text-right">ROAS Declarado</th>
                <th className="py-3 font-semibold text-right bg-teal-50/40 text-teal-800 px-3 rounded-t-lg">
                  ROAS Atribuído
                </th>
                <th className="py-3 font-semibold text-center">Incrementality Lift</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 text-xs">
              {!selectedChannel ? (
                // Top-Level Channels View
                getChannelData(selectedModel).map((ch) => {
                  const hasSpend = ch.spend > 0;
                  const hasRoas = ch.reportedRoas > 0;
                  
                  let liftPct = 0;
                  if (hasRoas && ch.modelRoas > 0) {
                    liftPct = ((ch.modelRoas - ch.reportedRoas) / ch.reportedRoas) * 100;
                  }

                  return (
                    <tr 
                      key={ch.channel} 
                      onClick={() => {
                        setSelectedChannel(ch.channel);
                        setExpandedCampaign(null);
                        setExpandedAdSet(null);
                      }}
                      className="hover:bg-slate-50/70 transition-colors cursor-pointer group text-slate-700"
                    >
                      {/* Channel Column */}
                      <td className="py-3.5 font-bold text-slate-800 flex items-center gap-2.5 pl-2">
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs shrink-0 ${
                          ch.channel.includes('Meta') 
                            ? 'bg-blue-50 text-blue-600 border border-blue-100' 
                            : ch.channel.includes('Google') 
                            ? 'bg-red-50 text-red-600 border border-red-100' 
                            : ch.channel.includes('TikTok') 
                            ? 'bg-slate-900 text-white' 
                            : ch.channel.includes('LinkedIn') 
                            ? 'bg-sky-50 text-sky-700 border border-sky-100' 
                            : ch.channel.includes('Email') 
                            ? 'bg-teal-50 text-teal-600 border border-teal-100'
                            : 'bg-slate-100 text-slate-600'
                        }`}>
                          {ch.channel[0]}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="block group-hover:text-teal-600 transition-colors">{ch.channel}</span>
                            <ArrowUpRight className="w-3 h-3 text-slate-400 opacity-0 group-hover:opacity-100 transition-all transform translate-x-[-4px] group-hover:translate-x-0" />
                          </div>
                          <span className="text-[9px] text-slate-400 font-mono font-medium uppercase block mt-0.5">
                            {hasSpend ? 'PAID CHANNEL' : 'ORGANIC SOURCE'}
                          </span>
                        </div>
                      </td>

                      {/* Investimento */}
                      <td className="py-3.5 text-right font-mono font-semibold text-slate-700">
                        {hasSpend ? `$${ch.spend.toLocaleString()}` : <span className="text-slate-300">-</span>}
                      </td>

                      {/* Visitantes */}
                      <td className="py-3.5 text-right font-mono text-slate-600">
                        {ch.visitors.toLocaleString()}
                      </td>

                      {/* Conversões */}
                      <td className="py-3.5 text-right font-mono text-slate-800">
                        {ch.conversions.toLocaleString()}
                      </td>

                      {/* Taxa de Conversão */}
                      <td className="py-3.5 text-right font-mono text-slate-600">
                        {ch.convRate}%
                      </td>

                      {/* CPA / CAC */}
                      <td className="py-3.5 text-right font-mono text-slate-700">
                        {hasSpend ? `$${ch.cpa.toFixed(2)}` : <span className="text-emerald-600 font-semibold text-[11px]">Orgânico</span>}
                      </td>

                      {/* ROAS Declarado */}
                      <td className="py-3.5 text-right font-mono text-slate-500">
                        {hasRoas ? `${ch.reportedRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                      </td>

                      {/* ROAS Atribuído */}
                      <td className="py-3.5 text-right font-mono font-bold text-teal-700 bg-teal-50/20 px-3">
                        {ch.modelRoas > 0 ? `${ch.modelRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                      </td>

                      {/* Diferença / Lift */}
                      <td className="py-3.5 text-center">
                        {hasRoas && ch.modelRoas > 0 ? (
                          <div className={`inline-flex items-center gap-0.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono ${
                            liftPct >= 0 
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                              : 'bg-rose-50 text-rose-700 border border-rose-100'
                          }`}>
                            {liftPct >= 0 ? `+${liftPct.toFixed(1)}%` : `${liftPct.toFixed(1)}%`}
                          </div>
                        ) : (
                          <span className="text-slate-400 font-mono text-[10px]">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                // Drilled-down view for selected channel (showing Campaigns -> Ad Sets -> Creatives)
                (() => {
                  const chData = getChannelData(selectedModel).find(c => c.channel === selectedChannel);
                  if (!chData) return null;
                  
                  const filteredCampaigns = getCampaignData(selectedChannel, chData);

                  return filteredCampaigns.map((camp) => {
                    const isCampExpanded = expandedCampaign === camp.utm_campaign;
                    const campHasSpend = camp.spend > 0;
                    const campHasRoas = camp.reportedRoas > 0;
                    
                    let campLiftPct = 0;
                    if (campHasRoas && camp.modelRoas > 0) {
                      campLiftPct = ((camp.modelRoas - camp.reportedRoas) / camp.reportedRoas) * 100;
                    }

                    return (
                      <React.Fragment key={camp.utm_campaign}>
                        {/* Campaign Row */}
                        <tr 
                          onClick={() => {
                            setExpandedCampaign(isCampExpanded ? null : camp.utm_campaign);
                            setExpandedAdSet(null);
                          }}
                          className={`hover:bg-slate-50/70 transition-colors cursor-pointer text-slate-700 ${
                            isCampExpanded ? 'bg-slate-50/40' : ''
                          }`}
                        >
                          {/* Name Column */}
                          <td className="py-3.5 pl-4 font-semibold text-slate-800 flex items-center gap-2">
                            <div className="p-1 hover:bg-slate-100 rounded-sm text-slate-500 shrink-0">
                              {isCampExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </div>
                            <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                            <div className="min-w-0">
                              <span className="block truncate font-bold text-slate-900 text-left" title={camp.utm_campaign}>
                                {camp.utm_campaign}
                              </span>
                              <span className="text-[9px] text-slate-400 font-mono font-bold uppercase block mt-0.5 text-left">
                                CAMPANHA (utm_campaign)
                              </span>
                            </div>
                          </td>

                          {/* Spend */}
                          <td className="py-3.5 text-right font-mono font-semibold text-slate-700">
                            {campHasSpend ? `$${camp.spend.toLocaleString()}` : <span className="text-slate-300">-</span>}
                          </td>

                          {/* Visitors */}
                          <td className="py-3.5 text-right font-mono text-slate-600">
                            {camp.visitors.toLocaleString()}
                          </td>

                          {/* Conversions */}
                          <td className="py-3.5 text-right font-mono text-slate-700">
                            {camp.conversions.toLocaleString()}
                          </td>

                          {/* Conversion Rate */}
                          <td className="py-3.5 text-right font-mono text-slate-600">
                            {camp.convRate}%
                          </td>

                          {/* CPA / CAC */}
                          <td className="py-3.5 text-right font-mono text-slate-700">
                            {campHasSpend ? `$${camp.cpa.toFixed(2)}` : <span className="text-emerald-600 font-semibold text-[11px]">Orgânico</span>}
                          </td>

                          {/* Reported ROAS */}
                          <td className="py-3.5 text-right font-mono text-slate-500">
                            {campHasRoas ? `${camp.reportedRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                          </td>

                          {/* Model ROAS */}
                          <td className="py-3.5 text-right font-mono font-bold text-teal-700 bg-teal-50/20 px-3">
                            {camp.modelRoas > 0 ? `${camp.modelRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                          </td>

                          {/* Lift / Gap */}
                          <td className="py-3.5 text-center">
                            {campHasRoas && camp.modelRoas > 0 ? (
                              <div className={`inline-flex items-center gap-0.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono ${
                                campLiftPct >= 0 
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                                  : 'bg-rose-50 text-rose-700 border border-rose-100'
                              }`}>
                                {campLiftPct >= 0 ? `+${campLiftPct.toFixed(1)}%` : `${campLiftPct.toFixed(1)}%`}
                              </div>
                            ) : (
                              <span className="text-slate-400 font-mono text-[10px]">-</span>
                            )}
                          </td>
                        </tr>

                        {/* Ad Sets Row List */}
                        {isCampExpanded && camp.adSets.map((as) => {
                          const isAsExpanded = expandedAdSet === as.term;
                          const asHasSpend = as.spend > 0;
                          const asHasRoas = as.reportedRoas > 0;
                          
                          let asLiftPct = 0;
                          if (asHasRoas && as.modelRoas > 0) {
                            asLiftPct = ((as.modelRoas - as.reportedRoas) / as.reportedRoas) * 100;
                          }

                          return (
                            <React.Fragment key={as.term}>
                              {/* Ad Set Row */}
                              <tr 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedAdSet(isAsExpanded ? null : as.term);
                                }}
                                className={`hover:bg-slate-100/60 transition-colors cursor-pointer bg-slate-50/40 border-l-4 text-slate-700 ${
                                  isAsExpanded ? 'border-indigo-400 bg-indigo-50/10' : 'border-slate-200'
                                }`}
                              >
                                {/* Name */}
                                <td className="py-2.5 pl-10 font-medium text-slate-700 flex items-center gap-2">
                                  <div className="w-5 h-5 flex items-center justify-center text-slate-400 shrink-0">
                                    {isAsExpanded ? <ChevronDown className="w-3.5 h-3.5 text-indigo-500" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                  </div>
                                  <Tag className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                                  <div className="min-w-0">
                                    <span className="block truncate text-[11px] font-semibold text-slate-800 text-left" title={as.term}>
                                      {as.term}
                                    </span>
                                    <span className="text-[8px] text-slate-400 font-mono font-bold uppercase tracking-wider block mt-0.5 text-left">
                                      CONJUNTO DE ANÚNCIOS (term)
                                    </span>
                                  </div>
                                </td>

                                {/* Spend */}
                                <td className="py-2.5 text-right font-mono text-slate-600">
                                  {asHasSpend ? `$${as.spend.toLocaleString()}` : <span className="text-slate-300">-</span>}
                                </td>

                                {/* Visitors */}
                                <td className="py-2.5 text-right font-mono text-slate-500">
                                  {as.visitors.toLocaleString()}
                                </td>

                                {/* Conversions */}
                                <td className="py-2.5 text-right font-mono text-slate-600">
                                  {as.conversions.toLocaleString()}
                                </td>

                                {/* Conversion Rate */}
                                <td className="py-2.5 text-right font-mono text-slate-500">
                                  {as.convRate}%
                                </td>

                                {/* CPA */}
                                <td className="py-2.5 text-right font-mono text-slate-600">
                                  {asHasSpend ? `$${as.cpa.toFixed(2)}` : <span className="text-emerald-600 font-semibold text-[11px]">Orgânico</span>}
                                </td>

                                {/* Reported ROAS */}
                                <td className="py-2.5 text-right font-mono text-slate-500">
                                  {asHasRoas ? `${as.reportedRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                                </td>

                                {/* Model ROAS */}
                                <td className="py-2.5 text-right font-mono font-bold text-indigo-700 bg-indigo-50/20 px-3">
                                  {as.modelRoas > 0 ? `${as.modelRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                                </td>

                                {/* Lift */}
                                <td className="py-2.5 text-center">
                                  {asHasRoas && as.modelRoas > 0 ? (
                                    <div className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[9px] font-bold font-mono ${
                                      asLiftPct >= 0 
                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                                        : 'bg-rose-50 text-rose-700 border border-rose-100'
                                    }`}>
                                      {asLiftPct >= 0 ? `+${asLiftPct.toFixed(1)}%` : `${asLiftPct.toFixed(1)}%`}
                                    </div>
                                  ) : (
                                    <span className="text-slate-400 font-mono text-[9px]">-</span>
                                  )}
                                </td>
                              </tr>

                              {/* Creatives List */}
                              {isAsExpanded && as.creatives.map((cr) => {
                                const crHasSpend = cr.spend > 0;
                                const crHasRoas = cr.reportedRoas > 0;
                                
                                let crLiftPct = 0;
                                if (crHasRoas && cr.modelRoas > 0) {
                                  crLiftPct = ((cr.modelRoas - cr.reportedRoas) / cr.reportedRoas) * 100;
                                }

                                return (
                                  <tr 
                                    key={cr.content}
                                    onClick={() => setSelectedCreative(cr)}
                                    className="bg-slate-50/70 hover:bg-slate-100/45 transition-colors border-l-4 border-slate-300 cursor-pointer text-xs text-slate-600"
                                  >
                                    {/* Name */}
                                    <td className="py-2 pl-20 font-normal text-slate-600 flex items-center gap-2">
                                      <div className="w-5 shrink-0" />
                                      <PlaySquare className="w-3.5 h-3.5 text-pink-500 shrink-0" />
                                      <div className="min-w-0">
                                        <span className="block truncate text-[11px] text-slate-700 font-medium text-left" title={cr.content}>
                                          {cr.content}
                                        </span>
                                        <span className="text-[8px] text-slate-400 font-mono font-bold uppercase tracking-wider block mt-0.5 text-left">
                                          CRIATIVO (content)
                                        </span>
                                      </div>
                                    </td>

                                    {/* Spend */}
                                    <td className="py-2 text-right font-mono text-slate-500">
                                      {crHasSpend ? `$${cr.spend.toLocaleString()}` : <span className="text-slate-300">-</span>}
                                    </td>

                                    {/* Visitors */}
                                    <td className="py-2 text-right font-mono text-slate-400">
                                      {cr.visitors.toLocaleString()}
                                    </td>

                                    {/* Conversions */}
                                    <td className="py-2 text-right font-mono text-slate-500">
                                      {cr.conversions.toLocaleString()}
                                    </td>

                                    {/* Conversion Rate */}
                                    <td className="py-2 text-right font-mono text-slate-400">
                                      {cr.convRate}%
                                    </td>

                                    {/* CPA */}
                                    <td className="py-2 text-right font-mono text-slate-500">
                                      {crHasSpend ? `$${cr.cpa.toFixed(2)}` : <span className="text-emerald-600 font-semibold text-[11px]">Orgânico</span>}
                                    </td>

                                    {/* Reported ROAS */}
                                    <td className="py-2 text-right font-mono text-slate-400">
                                      {crHasRoas ? `${cr.reportedRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                                    </td>

                                    {/* Model ROAS */}
                                    <td className="py-2 text-right font-mono font-semibold text-pink-700 bg-pink-50/20 px-3">
                                      {cr.modelRoas > 0 ? `${cr.modelRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                                    </td>

                                    {/* Lift */}
                                    <td className="py-2 text-center">
                                      {crHasRoas && cr.modelRoas > 0 ? (
                                        <div className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[9px] font-bold font-mono ${
                                          crLiftPct >= 0 
                                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                                            : 'bg-rose-50 text-rose-700 border border-rose-100'
                                        }`}>
                                          {crLiftPct >= 0 ? `+${crLiftPct.toFixed(1)}%` : `${crLiftPct.toFixed(1)}%`}
                                        </div>
                                      ) : (
                                        <span className="text-slate-400 font-mono text-[9px]">-</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </React.Fragment>
                          );
                        })}
                      </React.Fragment>
                    );
                  });
                })()
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Grid: Path touchpoints summary */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Histograms - Span 7 */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs lg:col-span-7">
          <div className="flex items-center gap-1.5 mb-4">
            <BarChart2 className="w-4.5 h-4.5 text-teal-600" />
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">User Touchpoint Sequence Frequency</h3>
          </div>

          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={touchpointData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f8fafc" vertical={false} />
                <XAxis dataKey="name" fontSize={10} fontFamily="JetBrains Mono" stroke="#94a3b8" tickLine={false} axisLine={false} />
                <YAxis fontSize={10} fontFamily="JetBrains Mono" stroke="#94a3b8" tickLine={false} axisLine={false} tickFormatter={(val) => `${val}%`} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#ffffff', 
                    border: '1px solid #e2e8f0', 
                    borderRadius: '12px',
                    fontFamily: 'Inter',
                    fontSize: '11px'
                  }}
                />
                <Bar dataKey="Percentage" fill="#0f172a" radius={[6, 6, 0, 0]} barSize={40} name="Sequence Share (%)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Dynamic Tip Panel - Span 5 */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs lg:col-span-5 flex flex-col justify-between">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono mb-3">Model Recommendation</h3>
            
            <div className="space-y-4">
              <div className="p-3 bg-teal-50 border border-teal-100/50 rounded-xl">
                <span className="text-[10px] font-mono text-teal-800 font-bold uppercase block mb-1">PROSPECTING GAIN</span>
                <p className="text-xs text-teal-950 font-sans leading-normal">
                  Facebook prospecting campaigns show an average <b className="font-semibold">+130% under-reporting gap</b>. Re-distribute 15% budget from low-performing retargeting lists to CostCap campaigns.
                </p>
              </div>

              <div className="p-3 bg-amber-50 border border-amber-100/50 rounded-xl">
                <span className="text-[10px] font-mono text-amber-800 font-bold uppercase block mb-1">TIKTOK DECAY</span>
                <p className="text-xs text-amber-950 font-sans leading-normal">
                  TikTok click quality scores are dropping (6.5/10). Touchpoint overlaps indicate TikTok is acting as a low-value mid-touch rather than first-click driver.
                </p>
              </div>
            </div>
          </div>

          <p className="text-[10px] text-slate-400 font-mono mt-4 leading-normal">
            Recommendations are computed using multi-touch game theory calculations. Update weekly to ensure stable budget efficiency ratios.
          </p>
        </div>
      </div>

      {/* Creative Performance Modal */}
      {selectedCreative && (() => {
        const crType = (() => {
          const n = selectedCreative.content.toLowerCase();
          if (n.includes('vídeo') || n.includes('video') || n.includes('ttv') || n.includes('ugc') || n.includes('unboxing') || n.includes('tutorial')) {
            return 'video';
          }
          if (n.includes('foto') || n.includes('imagem') || n.includes('grid') || n.includes('carrossel') || n.includes('post') || n.includes('infográfico') || n.includes('checklist')) {
            return 'image';
          }
          return 'text';
        })();

        const crChannel = selectedCreative.content.startsWith('[AD-T') ? 'Google Ads' : 'Meta Ads';

        const liftPct = selectedCreative.reportedRoas > 0 
          ? ((selectedCreative.modelRoas - selectedCreative.reportedRoas) / selectedCreative.reportedRoas) * 100
          : 0;

        const handleDownload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 1200;
          canvas.height = 630;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          
          // Gradient Background
          const grad = ctx.createLinearGradient(0, 0, 1200, 630);
          grad.addColorStop(0, '#0f172a');
          grad.addColorStop(1, '#0d9488');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, 1200, 630);
          
          // Decorative background visuals
          ctx.fillStyle = 'rgba(20, 184, 166, 0.1)';
          ctx.beginPath();
          ctx.arc(1050, 150, 250, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.fillStyle = 'rgba(99, 102, 241, 0.12)';
          ctx.beginPath();
          ctx.arc(150, 480, 180, 0, Math.PI * 2);
          ctx.fill();
          
          // Truvo Header Brand
          ctx.fillStyle = '#2dd4bf';
          ctx.font = 'bold 26px monospace';
          ctx.fillText('TRUVO ANALYTICS', 80, 80);
          
          // Subtitle tag
          ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(80, 110, 190, 36, 6);
            ctx.fill();
          } else {
            ctx.fillRect(80, 110, 190, 36);
          }
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 13px sans-serif';
          ctx.fillText('CRIATIVO EXPORTADO', 102, 133);
          
          // Creative Name
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 42px sans-serif';
          const words = selectedCreative.content.split(' ');
          let line = '';
          let y = 220;
          for (let n = 0; n < words.length; n++) {
            let testLine = line + words[n] + ' ';
            let metrics = ctx.measureText(testLine);
            if (metrics.width > 950 && n > 0) {
              ctx.fillText(line, 80, y);
              line = words[n] + ' ';
              y += 55;
            } else {
              line = testLine;
            }
          }
          ctx.fillText(line, 80, y);
          
          // Model Attribution subtitle
          ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.font = '500 18px sans-serif';
          ctx.fillText('Métricas de Performance Atribuídas (Modelo Truvo AI Graph):', 80, 380);
          
          // Draw cards for 4 core metrics
          const items = [
            { label: 'INVESTIMENTO', val: selectedCreative.spend > 0 ? `$${selectedCreative.spend.toLocaleString()}` : 'Orgânico', color: '#ffffff' },
            { label: 'VISITANTES', val: selectedCreative.visitors.toLocaleString(), color: '#ffffff' },
            { label: 'CONVERSÕES', val: selectedCreative.conversions.toLocaleString(), color: '#ffffff' },
            { label: 'ROAS ATRIBUÍDO', val: selectedCreative.modelRoas > 0 ? `${selectedCreative.modelRoas.toFixed(2)}x` : '-', color: '#2dd4bf' }
          ];
          
          items.forEach((item, idx) => {
            const x = 80 + idx * 265;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(x, 410, 240, 115, 10);
              ctx.fill();
            } else {
              ctx.fillRect(x, 410, 240, 115);
            }
            
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.lineWidth = 1;
            ctx.stroke();
            
            ctx.fillStyle = '#94a3b8';
            ctx.font = 'bold 12px monospace';
            ctx.fillText(item.label, x + 20, 442);
            
            ctx.fillStyle = item.color;
            ctx.font = 'bold 28px sans-serif';
            ctx.fillText(item.val, x + 20, 488);
          });
          
          ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
          ctx.font = '12px monospace';
          ctx.fillText('Sincronizado via Truvo Graph API. Todos os direitos reservados.', 80, 580);
          
          const link = document.createElement('a');
          link.download = `${selectedCreative.content.replace(/\[|\]/g, '').replace(/\s+/g, '_')}_performance.png`;
          link.href = canvas.toDataURL('image/png');
          link.click();
        };

        return (
          <div id="creative-metrics-modal" className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs z-50 flex items-center justify-center p-4 overflow-y-auto text-slate-700">
            {/* Backdrop Click */}
            <div className="absolute inset-0 cursor-default" onClick={() => {
              setSelectedCreative(null);
              setIsPlaying(false);
              setVideoProgress(0);
            }} />
            
            {/* Modal Container */}
            <div className="bg-white rounded-3xl max-w-5xl w-full border border-slate-100 shadow-2xl overflow-hidden relative z-10 flex flex-col lg:flex-row max-h-[92vh] lg:max-h-[85vh] animate-scaleIn">
              
              {/* Left Side: Mock Ad Preview */}
              <div className="w-full lg:w-[45%] bg-slate-950 p-6 flex flex-col justify-center items-center border-b lg:border-b-0 lg:border-r border-slate-900 min-h-[350px] lg:min-h-0 relative group">
                
                {/* Floating Tag */}
                <div className="absolute top-4 left-4 z-10 bg-slate-900/80 border border-slate-800 text-[10px] font-mono text-pink-400 px-2.5 py-1 rounded-full uppercase font-bold tracking-wider">
                  {crType === 'video' ? 'Video UGC Spark Ad' : crType === 'image' ? 'Social Post Creative' : 'Search / Text Creative'}
                </div>

                {crType === 'video' && (
                  <div className="w-full max-w-[240px] aspect-[9/16] bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 relative shadow-2xl flex flex-col justify-between p-4">
                    {/* Background subtle looping visual pulse */}
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-teal-950/20 to-slate-900 z-0" />
                    
                    {/* Header bar */}
                    <div className="flex justify-between items-center z-10 text-[10px] font-mono text-white/60">
                      <span className="bg-white/10 px-1.5 py-0.5 rounded-sm">AO VIVO</span>
                      <span>{crChannel?.split(' ')[0]}</span>
                    </div>

                    {/* Mid Visual Play/Pause */}
                    <div className="flex-1 flex items-center justify-center z-10">
                      <button 
                        onClick={() => setIsPlaying(!isPlaying)}
                        className="w-14 h-14 rounded-full bg-teal-500/90 hover:bg-teal-400 text-slate-950 flex items-center justify-center transition-all hover:scale-110 active:scale-95 cursor-pointer shadow-lg shadow-teal-500/30"
                      >
                        {isPlaying ? (
                          <span className="flex gap-1 items-center justify-center">
                            <span className="w-1.5 h-6 bg-slate-950 rounded-xs animate-pulse" />
                            <span className="w-1.5 h-6 bg-slate-950 rounded-xs animate-pulse" />
                          </span>
                        ) : (
                          <span className="ml-1 border-y-[10px] border-y-transparent border-l-[18px] border-l-slate-950" />
                        )}
                      </button>
                    </div>

                    {/* Bottom Info details */}
                    <div className="z-10 text-white space-y-2">
                      <div className="text-[11px] font-semibold tracking-tight leading-tight bg-slate-950/50 p-2 rounded-lg backdrop-blur-xs text-left">
                        <p className="text-teal-400 font-bold mb-0.5">@truvo_analytics</p>
                        <p className="text-[10px] text-slate-200 line-clamp-2">{selectedCreative.content}</p>
                      </div>
                      
                      {/* Animated Progress Bar */}
                      <div className="space-y-1">
                        <div className="flex justify-between text-[8px] font-mono text-white/50">
                          <span>SIMULAÇÃO DE PLAYER</span>
                          <span>{Math.round(videoProgress)}%</span>
                        </div>
                        <div className="w-full h-1 bg-white/20 rounded-full overflow-hidden">
                          <div className="h-full bg-teal-400 transition-all duration-75" style={{ width: `${videoProgress}%` }} />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {crType === 'image' && (
                  <div className="w-full max-w-[280px] bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 relative shadow-2xl">
                    {/* Avatar / Sponsor Line */}
                    <div className="p-3 flex items-center gap-2.5 border-b border-slate-800 text-left">
                      <div className="w-6 h-6 rounded-full bg-teal-500/20 border border-teal-500/50 flex items-center justify-center text-teal-400 font-bold text-[9px]">T</div>
                      <div>
                        <span className="block text-[10px] font-bold text-slate-200 leading-tight text-left">Truvo Partner Ad</span>
                        <span className="block text-[8px] text-slate-400 leading-tight text-left">Patrocinado • {crChannel}</span>
                      </div>
                    </div>

                    {/* Visual Body Frame */}
                    <div className="aspect-square bg-gradient-to-br from-slate-900 to-teal-950 flex flex-col justify-between p-4 relative group">
                      {/* Seasonal overlay decoration */}
                      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(20,184,166,0.15),transparent)] pointer-events-none" />
                      
                      <span className="text-[9px] font-mono font-bold bg-slate-950/80 text-teal-400 border border-teal-900/50 px-2 py-0.5 rounded-sm uppercase tracking-wider self-start z-10">
                        WINTER CO. 2026
                      </span>

                      <div className="my-auto text-center space-y-1 z-10">
                        <p className="text-[13px] font-bold text-white tracking-tight leading-tight">
                          DESCONTO EXCLUSIVO ATRIBUÍDO
                        </p>
                        <p className="text-[10px] text-slate-300">
                          Use o código: <span className="font-mono bg-teal-500/20 text-teal-300 font-bold px-1 py-0.5 rounded-sm">QUERO10</span>
                        </p>
                      </div>

                      <div className="w-full bg-teal-500 hover:bg-teal-400 text-slate-950 text-center py-2 rounded-lg text-[10px] font-bold transition-all z-10">
                        COMPRAR AGORA
                      </div>
                    </div>

                    {/* Interactive footer actions */}
                    <div className="p-3 border-t border-slate-800 flex items-center justify-between text-[9px] text-slate-400">
                      <span>❤️ 1,248 curtidas</span>
                      <span className="font-mono text-[8px]">Carrossel 1/2</span>
                    </div>
                  </div>
                )}

                {crType === 'text' && (
                  <div className="w-full max-w-[320px] bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 p-4 space-y-3.5 shadow-2xl text-left">
                    {/* Google mock search head */}
                    <div className="space-y-1 border-b border-slate-800 pb-2.5">
                      <div className="flex items-center gap-1 text-[9px] text-slate-400">
                        <span>https://www.truvo.com.br</span>
                        <span className="text-[7px]">▼</span>
                      </div>
                      <h4 className="text-[12px] font-bold text-sky-400 hover:underline cursor-pointer leading-snug">
                        {selectedCreative.content}
                      </h4>
                    </div>
                    {/* Meta desc */}
                    <p className="text-[10px] text-slate-300 leading-relaxed">
                      Atribuição baseada em grafos que corrige a subnotificação do Meta e TikTok Ads causadas por cookies de terceiros e iOS 14. Descubra o ROAS real em minutos.
                    </p>
                    
                    <div className="pt-2 flex flex-wrap gap-1.5 border-t border-slate-850">
                      <span className="text-[8px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-md font-mono">Multi-Touch</span>
                      <span className="text-[8px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-md font-mono">Atribuição Real</span>
                      <span className="text-[8px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-md font-mono">Sem Cookies</span>
                    </div>
                  </div>
                )}

                <div className="mt-4 text-center z-10">
                  <p className="text-[10px] text-slate-500 font-mono">CRIATIVO INTEGRADO TRUVO ANALYTICS SDK</p>
                </div>
              </div>

              {/* Right Side: Performance Metrics & Actions */}
              <div className="w-full lg:w-[55%] p-6 md:p-8 flex flex-col justify-between bg-slate-50 overflow-y-auto">
                {/* Header Details */}
                <div>
                  <div className="flex justify-between items-start gap-4">
                    <div className="text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-slate-400 font-bold uppercase tracking-wider">
                          Análise Detalhada de Atribuição
                        </span>
                        <span className="bg-pink-100 text-pink-800 font-mono font-bold text-[8px] px-2 py-0.5 rounded-full uppercase">
                          Active Ad
                        </span>
                      </div>
                      <h3 className="text-base font-bold text-slate-800 tracking-tight mt-1">
                        {selectedCreative.content}
                      </h3>
                    </div>

                    {/* Close button */}
                    <button 
                      onClick={() => {
                        setSelectedCreative(null);
                        setIsPlaying(false);
                        setVideoProgress(0);
                      }}
                      className="w-8 h-8 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-600 hover:text-slate-900 flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Brief Explanatory Alert */}
                  <div className="bg-teal-50 border border-teal-100/70 p-3 rounded-xl flex items-start gap-2.5 mt-4 text-xs text-teal-800 text-left">
                    <Sparkles className="w-4 h-4 text-teal-600 shrink-0 mt-0.5" />
                    <div className="font-sans">
                      <span className="font-bold">Otimização Truvo Graph:</span> Este criativo obteve uma taxa de conversão real de <b>{selectedCreative.convRate}%</b>, ultrapassando os relatórios de cliques padrões das redes de anúncios.
                    </div>
                  </div>

                  {/* Performance Grid */}
                  <div className="grid grid-cols-2 gap-3 mt-5">
                    <div className="bg-white p-3 rounded-xl border border-slate-150/80 shadow-2xs text-left">
                      <span className="text-[9px] font-mono text-slate-400 uppercase font-semibold">Investimento</span>
                      <p className="text-sm font-bold text-slate-700 mt-1 font-mono">
                        {selectedCreative.spend > 0 ? `$${selectedCreative.spend.toLocaleString()}` : <span className="text-slate-400 font-normal italic text-xs">Orgânico</span>}
                      </p>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-slate-150/80 shadow-2xs text-left">
                      <span className="text-[9px] font-mono text-slate-400 uppercase font-semibold">Visitantes Únicos</span>
                      <p className="text-sm font-bold text-slate-700 mt-1 font-mono">
                        {selectedCreative.visitors.toLocaleString()}
                      </p>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-slate-150/80 shadow-2xs text-left">
                      <span className="text-[9px] font-mono text-slate-400 uppercase font-semibold">Conversões Atribuídas</span>
                      <p className="text-sm font-bold text-slate-850 mt-1 font-mono text-teal-700 text-left">
                        {selectedCreative.conversions.toLocaleString()}
                      </p>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-slate-150/80 shadow-2xs text-left">
                      <span className="text-[9px] font-mono text-slate-400 uppercase font-semibold">CPA Atribuído</span>
                      <p className="text-sm font-bold text-slate-700 mt-1 font-mono">
                        {selectedCreative.spend > 0 ? `$${selectedCreative.cpa.toFixed(2)}` : <span className="text-emerald-600 font-semibold text-xs">Gratuito</span>}
                      </p>
                    </div>
                  </div>

                  {/* ROAS Side-by-Side comparison */}
                  <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs mt-4 space-y-3.5 text-left">
                    <h4 className="text-[10px] font-mono text-slate-400 font-bold uppercase tracking-wider">
                      Divergência de Atribuição (ROAS)
                    </h4>
                    
                    <div className="grid grid-cols-2 gap-4">
                      {/* Reported ROAS */}
                      <div className="space-y-1">
                        <span className="text-[9px] text-slate-400 font-mono font-semibold">ROAS Declarado (Pixel)</span>
                        <div className="text-lg font-bold text-slate-400 font-mono">
                          {selectedCreative.reportedRoas > 0 ? `${selectedCreative.reportedRoas.toFixed(2)}x` : '-'}
                        </div>
                        <p className="text-[8px] text-slate-400 text-left">Notificado no Gerenciador</p>
                      </div>

                      {/* Model ROAS */}
                      <div className="space-y-1 border-l border-slate-100 pl-4">
                        <span className="text-[9px] text-teal-600 font-mono font-bold flex items-center gap-1">
                          ROAS Real (Truvo AI)
                          <Sparkles className="w-2.5 h-2.5 text-teal-500" />
                        </span>
                        <div className="text-lg font-bold text-teal-700 font-mono">
                          {selectedCreative.modelRoas > 0 ? `${selectedCreative.modelRoas.toFixed(2)}x` : '-'}
                        </div>
                        <p className="text-[8px] text-teal-600 text-left">Calculado via Multi-Touch Graph</p>
                      </div>
                    </div>

                    {/* Lift percentage bar and helper */}
                    {liftPct > 0 && (
                      <div className="bg-emerald-50 border border-emerald-100/50 p-2.5 rounded-lg flex items-center justify-between text-[11px] text-emerald-800">
                        <span className="font-semibold text-left">Aumento de Visibilidade:</span>
                        <span className="font-mono font-bold bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded-sm">
                          +{liftPct.toFixed(1)}% ROAS Real
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Bottom Action buttons */}
                <div className="mt-6 pt-4 border-t border-slate-200 flex flex-col sm:flex-row gap-2 w-full">
                  <button 
                    onClick={handleDownload}
                    className="flex-1 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-md shadow-teal-600/10"
                  >
                    <Download className="w-4 h-4" />
                    <span>Baixar Relatório de Criativo (PNG)</span>
                  </button>
                  <button 
                    onClick={() => {
                      setSelectedCreative(null);
                      setIsPlaying(false);
                      setVideoProgress(0);
                    }}
                    className="py-2.5 px-4 bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 border border-slate-200 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Fechar
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
