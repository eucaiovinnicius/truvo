'use client';

import React, { useState, useEffect } from 'react';
import { 
  Plus, 
  Search, 
  Layers, 
  Trash2, 
  Edit, 
  TrendingUp, 
  CheckCircle, 
  AlertCircle,
  Clock,
  Sparkles,
  Zap,
  BarChart2,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  ArrowDown,
  Percent,
  Users,
  Target,
  TrendingDown,
  Info,
  Shuffle,
  ArrowUpRight,
  Folder,
  Tag,
  PlaySquare,
  Download,
  X
} from 'lucide-react';
import { Funnel } from '../types';
import { useLive } from '@/lib/live';
import { LiveDataBoundary } from '@/lib/live-ui';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';

/** status local do funil → enum da API (M5): inactive ↔ archived. */
function localToApiFunnelStatus(status: 'active' | 'inactive' | 'draft'): 'active' | 'archived' | 'draft' {
  return status === 'inactive' ? 'archived' : status;
}

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

// TODO(live): getChannelData/getCampaignData (Attribution Analyzer drilldown)
// seguem no mock — ligar via /v1/attribution.
function getChannelData(
  funnelId: string,
  reachStart: number, 
  reachEnd: number, 
  selectedModel: 'truvo_ml' | 'first_click' | 'last_click' | 'linear'
): FunnelChannelPerformance[] {
  if (funnelId === 'ecommerce-main') {
    if (selectedModel === 'truvo_ml') {
      return [
        { channel: 'Meta Ads', spend: 45000, visitors: 45000, conversions: 1512, convRate: 3.4, cpa: 29.76, reportedRoas: 1.85, modelRoas: 2.75 },
        { channel: 'Google Search', spend: 28000, visitors: 25000, conversions: 1120, convRate: 4.5, cpa: 25.00, reportedRoas: 2.90, modelRoas: 3.45 },
        { channel: 'TikTok Ads', spend: 18000, visitors: 20000, conversions: 420, convRate: 2.1, cpa: 42.85, reportedRoas: 1.10, modelRoas: 1.85 },
        { channel: 'Email/Klaviyo', spend: 1500, visitors: 5000, conversions: 348, convRate: 6.9, cpa: 4.31, reportedRoas: 12.50, modelRoas: 15.20 },
        { channel: 'Direct / Organic', spend: 0, visitors: 5000, conversions: 100, convRate: 2.0, cpa: 0, reportedRoas: 0, modelRoas: 0 }
      ];
    } else if (selectedModel === 'first_click') {
      return [
        { channel: 'Meta Ads', spend: 45000, visitors: 45000, conversions: 1820, convRate: 4.0, cpa: 24.72, reportedRoas: 1.85, modelRoas: 3.31 },
        { channel: 'Google Search', spend: 28000, visitors: 25000, conversions: 810, convRate: 3.2, cpa: 34.56, reportedRoas: 2.90, modelRoas: 2.50 },
        { channel: 'TikTok Ads', spend: 18000, visitors: 20000, conversions: 590, convRate: 2.9, cpa: 30.50, reportedRoas: 1.10, modelRoas: 2.60 },
        { channel: 'Email/Klaviyo', spend: 1500, visitors: 5000, conversions: 120, convRate: 2.4, cpa: 12.50, reportedRoas: 12.50, modelRoas: 5.24 },
        { channel: 'Direct / Organic', spend: 0, visitors: 5000, conversions: 160, convRate: 3.2, cpa: 0, reportedRoas: 0, modelRoas: 0 }
      ];
    } else if (selectedModel === 'last_click') {
      return [
        { channel: 'Meta Ads', spend: 45000, visitors: 45000, conversions: 980, convRate: 2.2, cpa: 45.91, reportedRoas: 1.85, modelRoas: 1.78 },
        { channel: 'Google Search', spend: 28000, visitors: 25000, conversions: 1450, convRate: 5.8, cpa: 19.31, reportedRoas: 2.90, modelRoas: 4.48 },
        { channel: 'TikTok Ads', spend: 18000, visitors: 20000, conversions: 210, convRate: 1.0, cpa: 85.71, reportedRoas: 1.10, modelRoas: 0.92 },
        { channel: 'Email/Klaviyo', spend: 1500, visitors: 5000, conversions: 720, convRate: 14.4, cpa: 2.08, reportedRoas: 12.50, modelRoas: 31.40 },
        { channel: 'Direct / Organic', spend: 0, visitors: 5000, conversions: 140, convRate: 2.8, cpa: 0, reportedRoas: 0, modelRoas: 0 }
      ];
    } else { // linear
      return [
        { channel: 'Meta Ads', spend: 45000, visitors: 45000, conversions: 1300, convRate: 2.9, cpa: 34.61, reportedRoas: 1.85, modelRoas: 2.36 },
        { channel: 'Google Search', spend: 28000, visitors: 25000, conversions: 1120, convRate: 4.5, cpa: 25.00, reportedRoas: 2.90, modelRoas: 3.45 },
        { channel: 'TikTok Ads', spend: 18000, visitors: 20000, conversions: 410, convRate: 2.0, cpa: 43.90, reportedRoas: 1.10, modelRoas: 1.80 },
        { channel: 'Email/Klaviyo', spend: 1500, visitors: 5000, conversions: 430, convRate: 8.6, cpa: 3.48, reportedRoas: 12.50, modelRoas: 18.70 },
        { channel: 'Direct / Organic', spend: 0, visitors: 5000, conversions: 240, convRate: 4.8, cpa: 0, reportedRoas: 0, modelRoas: 0 }
      ];
    }
  } else if (funnelId === 'saas-onboarding') {
    if (selectedModel === 'truvo_ml') {
      return [
        { channel: 'Google Ads (Search)', spend: 15000, visitors: 17500, conversions: 2432, convRate: 13.9, cpa: 61.70, reportedRoas: 2.10, modelRoas: 2.95 },
        { channel: 'LinkedIn Ads', spend: 25000, visitors: 15000, conversions: 1408, convRate: 9.3, cpa: 113.60, reportedRoas: 1.25, modelRoas: 2.10 },
        { channel: 'Organic / Blog', spend: 0, visitors: 10000, conversions: 1600, convRate: 16.0, cpa: 0, reportedRoas: 0, modelRoas: 0 },
        { channel: 'Direct Access', spend: 0, visitors: 5000, conversions: 768, convRate: 15.3, cpa: 0, reportedRoas: 0, modelRoas: 0 },
        { channel: 'Newsletter Referral', spend: 500, visitors: 2500, conversions: 192, convRate: 7.6, cpa: 52.00, reportedRoas: 3.40, modelRoas: 4.80 }
      ];
    } else if (selectedModel === 'first_click') {
      return [
        { channel: 'Google Ads (Search)', spend: 15000, visitors: 17500, conversions: 2810, convRate: 16.0, cpa: 53.38, reportedRoas: 2.10, modelRoas: 3.41 },
        { channel: 'LinkedIn Ads', spend: 25000, visitors: 15000, conversions: 1950, convRate: 13.0, cpa: 82.05, reportedRoas: 1.25, modelRoas: 2.90 },
        { channel: 'Organic / Blog', spend: 0, visitors: 10000, conversions: 1800, convRate: 18.0, cpa: 0, reportedRoas: 0, modelRoas: 0 },
        { channel: 'Direct Access', spend: 0, visitors: 5000, conversions: 480, convRate: 9.6, cpa: 0, reportedRoas: 0, modelRoas: 0 },
        { channel: 'Newsletter Referral', spend: 500, visitors: 2500, conversions: 120, convRate: 4.8, cpa: 83.33, reportedRoas: 3.40, modelRoas: 3.00 }
      ];
    } else if (selectedModel === 'last_click') {
      return [
        { channel: 'Google Ads (Search)', spend: 15000, visitors: 17500, conversions: 1920, convRate: 10.9, cpa: 78.12, reportedRoas: 2.10, modelRoas: 2.33 },
        { channel: 'LinkedIn Ads', spend: 25000, visitors: 15000, conversions: 910, convRate: 6.0, cpa: 175.80, reportedRoas: 1.25, modelRoas: 1.35 },
        { channel: 'Organic / Blog', spend: 0, visitors: 10000, conversions: 1500, convRate: 15.0, cpa: 0, reportedRoas: 0, modelRoas: 0 },
        { channel: 'Direct Access', spend: 0, visitors: 5000, conversions: 960, convRate: 19.2, cpa: 0, reportedRoas: 0, modelRoas: 0 },
        { channel: 'Newsletter Referral', spend: 500, visitors: 2500, conversions: 310, convRate: 12.4, cpa: 32.25, reportedRoas: 3.40, modelRoas: 7.75 }
      ];
    } else { // linear
      return [
        { channel: 'Google Ads (Search)', spend: 15000, visitors: 17500, conversions: 2380, convRate: 13.6, cpa: 63.02, reportedRoas: 2.10, modelRoas: 2.89 },
        { channel: 'LinkedIn Ads', spend: 25000, visitors: 15000, conversions: 1420, convRate: 9.4, cpa: 112.67, reportedRoas: 1.25, modelRoas: 2.11 },
        { channel: 'Organic / Blog', spend: 0, visitors: 10000, conversions: 1630, convRate: 16.3, cpa: 0, reportedRoas: 0, modelRoas: 0 },
        { channel: 'Direct Access', spend: 0, visitors: 5000, conversions: 730, convRate: 14.6, cpa: 0, reportedRoas: 0, modelRoas: 0 },
        { channel: 'Newsletter Referral', spend: 500, visitors: 2500, conversions: 210, convRate: 8.4, cpa: 47.62, reportedRoas: 3.40, modelRoas: 5.25 }
      ];
    }
  } else {
    // Fallback formula for other funnels
    const factor = selectedModel === 'truvo_ml' ? 1.3 : selectedModel === 'first_click' ? 1.5 : selectedModel === 'last_click' ? 0.8 : 1.0;
    const factorG = selectedModel === 'truvo_ml' ? 1.2 : selectedModel === 'first_click' ? 0.9 : selectedModel === 'last_click' ? 1.4 : 1.0;

    return [
      { 
        channel: 'Meta Ads', 
        spend: Math.round(reachStart * 0.15), 
        visitors: Math.round(reachStart * 0.50), 
        conversions: Math.round(reachEnd * 0.50 * factor), 
        convRate: reachStart > 0 ? Number(((reachEnd * 0.50 * factor) / (reachStart * 0.50) * 100).toFixed(1)) : 0, 
        cpa: reachEnd > 0 && reachEnd * 0.50 * factor > 0 ? Number((Math.round(reachStart * 0.15) / (reachEnd * 0.50 * factor)).toFixed(2)) : 0, 
        reportedRoas: 1.50, 
        modelRoas: 1.50 * factor 
      },
      { 
        channel: 'Google Search', 
        spend: Math.round(reachStart * 0.10), 
        visitors: Math.round(reachStart * 0.30), 
        conversions: Math.round(reachEnd * 0.30 * factorG), 
        convRate: reachStart > 0 ? Number(((reachEnd * 0.30 * factorG) / (reachStart * 0.30) * 100).toFixed(1)) : 0, 
        cpa: reachEnd > 0 && reachEnd * 0.30 * factorG > 0 ? Number((Math.round(reachStart * 0.10) / (reachEnd * 0.30 * factorG)).toFixed(2)) : 0, 
        reportedRoas: 2.20, 
        modelRoas: 2.20 * factorG 
      },
      { 
        channel: 'Organic / Direct', 
        spend: 0, 
        visitors: Math.round(reachStart * 0.20), 
        conversions: Math.round(reachEnd * 0.20), 
        convRate: reachStart > 0 ? Number(((reachEnd * 0.20) / (reachStart * 0.20) * 100).toFixed(1)) : 0, 
        cpa: 0, 
        reportedRoas: 0, 
        modelRoas: 0 
      }
    ];
  }
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

function getCampaignData(
  funnelId: string,
  channel: string,
  parent: FunnelChannelPerformance
): CampaignPerformance[] {
  let campaignNames: string[] = [];
  let adSetNamesGroup: string[][] = [];
  let creativeNamesGroup: string[][][] = [];

  if (channel.includes('Meta Ads')) {
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
  } else if (channel.includes('Google Search') || channel.includes('Google Ads')) {
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
  } else if (channel.includes('TikTok Ads')) {
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
  } else if (channel.includes('LinkedIn Ads')) {
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
  } else if (channel.includes('Email') || channel.includes('Newsletter')) {
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

// ---- API (M5) → forma que o JSX já consome. adapt() local + fallback demo. ----

interface FunnelStepApi {
  step_id: string;
  name: string;
  event: string;
  conditions?: unknown[];
}

interface FunnelViewApi {
  id: string;
  name: string;
  status: 'active' | 'archived' | 'draft';
  attribution_window_days?: number;
  steps?: FunnelStepApi[] | null;
  alert?: unknown;
  sparkline?: number[] | null;
  created_at?: string;
  updated_at?: string;
}

interface FunnelStatsStepApi {
  step_id: string;
  name: string;
  event: string;
  users_entered: number | null;
  conversion_rate: number | null;
}

interface FunnelStatsApi {
  overall_conversion_rate: number | null;
  total_visitors: number | null;
  total_revenue: number | null;
  steps?: FunnelStatsStepApi[] | null;
  best_traffic_source?: string | null;
}

/** GET /v1/funnels → mesma forma Funnel que o grid já renderiza. */
function adaptFunnels(rows: FunnelViewApi[]): Funnel[] {
  return (rows ?? []).map((f) => {
    const steps = f.steps ?? [];
    return {
      id: f.id,
      name: f.name,
      status: f.status === 'archived' ? 'inactive' : f.status,
      conversionRate: 0,
      totalSteps: steps.length,
      steps: steps.map((s, i) => ({
        id: s.step_id || `s${i}`,
        stepNumber: i + 1,
        name: s.name,
        eventType: s.event,
        conditions: [],
        reach: 0,
      })),
      updatedTime: '',
      sparklineData: f.sparkline ?? [],
    };
  });
}

/** GET /v1/funnels/{id}/stats → preenche reach (users_entered) e conversão do funil aberto. */
function applyFunnelStats(f: Funnel, stats: FunnelStatsApi): Funnel {
  const statSteps = stats.steps ?? [];
  const byId = new Map<string, FunnelStatsStepApi>();
  statSteps.forEach((s) => {
    if (s.step_id) byId.set(s.step_id, s);
  });
  return {
    ...f,
    conversionRate: stats.overall_conversion_rate ?? f.conversionRate,
    steps: f.steps.map((step, i) => {
      const st = byId.get(step.id) ?? statSteps[i];
      return { ...step, reach: st?.users_entered ?? step.reach };
    }),
  };
}

interface FunnelsViewProps {
  funnels: Funnel[];
  setFunnels: React.Dispatch<React.SetStateAction<Funnel[]>>;
  onEditFunnel: (funnelId: string) => void;
  onAddNewFunnel: () => void;
}

export default function FunnelsView({ 
  funnels, 
  setFunnels, 
  onEditFunnel, 
  onAddNewFunnel 
}: FunnelsViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive' | 'draft'>('all');
  const [selectedPerformanceFunnelId, setSelectedPerformanceFunnelId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<'truvo_ml' | 'first_click' | 'last_click' | 'linear'>('truvo_ml');

  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);
  const [expandedAdSet, setExpandedAdSet] = useState<string | null>(null);
  const [selectedCreative, setSelectedCreative] = useState<CreativePerformance | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);

  // ---- Live (API real). Em modo demo useLive retorna null → cai nas props/mock. ----
  const session = useSession();
  const workspaceId = session.workspace?.id;
  const isLive = session.isLive;

  // GRID: GET /v1/funnels. Quando 'live' chega, semeia o estado do pai — assim o
  // grid e as mutações locais (toggle/delete/create) seguem lendo `funnels` intactos.
  const funnelsLive = useLive<FunnelViewApi[]>('/v1/funnels', [workspaceId]);
  useEffect(() => {
    if (funnelsLive.status === 'success') {
      setFunnels(adaptFunnels(funnelsLive.data ?? []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnelsLive.status, funnelsLive.data]);

  // Stats do funil aberto: GET /v1/funnels/{id}/stats → reach/conversão reais.
  const statsPath = selectedPerformanceFunnelId
    ? `/v1/funnels/${selectedPerformanceFunnelId}/stats`
    : null;
  const statsLive = useLive<FunnelStatsApi>(statsPath, [selectedPerformanceFunnelId, workspaceId]);

  // Reset drilldown states when active performance funnel changes
  useEffect(() => {
    setSelectedChannel(null);
    setExpandedCampaign(null);
    setExpandedAdSet(null);
    setSelectedCreative(null);
    setIsPlaying(false);
    setVideoProgress(0);
  }, [selectedPerformanceFunnelId]);

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

  const nextFunnelStatus: Record<string, 'active' | 'inactive' | 'draft'> = {
    active: 'inactive',
    inactive: 'active',
    draft: 'active',
  };

  const applyStatus = (funnelId: string, status: 'active' | 'inactive' | 'draft') => {
    setFunnels((prev) => prev.map((f) => (f.id === funnelId ? { ...f, status } : f)));
  };

  // Toggle — demo: local; live: PATCH /v1/funnels/:id { status }.
  const handleToggleStatus = async (funnelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const current = funnels.find((f) => f.id === funnelId);
    if (!current) return;
    const next = nextFunnelStatus[current.status];
    if (!isLive) {
      applyStatus(funnelId, next);
      return;
    }
    try {
      await api(`/v1/funnels/${funnelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: localToApiFunnelStatus(next) }),
      });
      applyStatus(funnelId, next);
    } catch {
      window.alert('Não foi possível atualizar o status do funil. Tente novamente.');
    }
  };

  // Delete — demo: local; live: DELETE /v1/funnels/:id.
  const handleDeleteFunnel = async (funnelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (
      !window.confirm(
        'Tem certeza de que deseja excluir este funil de marketing? Todos os cálculos históricos serão reiniciados.',
      )
    ) {
      return;
    }
    if (isLive) {
      try {
        await api(`/v1/funnels/${funnelId}`, { method: 'DELETE' });
      } catch {
        window.alert('Não foi possível excluir o funil. Tente novamente.');
        return;
      }
    }
    setFunnels((prev) => prev.filter((f) => f.id !== funnelId));
    if (selectedPerformanceFunnelId === funnelId) {
      setSelectedPerformanceFunnelId(null);
    }
  };

  const filteredFunnels = funnels.filter(f => {
    const matchesSearch = f.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === 'all' || f.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  // Calculate high-level totals
  const totalFunnels = funnels.length;
  const activeFunnels = funnels.filter(f => f.status === 'active').length;
  const averageConversion = isLive
    ? '—'
    : funnels.filter(f => f.status === 'active').length > 0
    ? (funnels.filter(f => f.status === 'active').reduce((acc, curr) => acc + curr.conversionRate, 0) / activeFunnels).toFixed(1)
    : '0.0';

  // Find currently selected performance funnel (com reach/conversão reais quando 'live').
  const baseFunnel = funnels.find(f => f.id === selectedPerformanceFunnelId);
  const performanceFunnel = baseFunnel && statsLive.status === 'success' && statsLive.data
    ? applyFunnelStats(baseFunnel, statsLive.data)
    : baseFunnel;

  // If a performance funnel is selected, render the detailed drilldown
  if (performanceFunnel) {
    const steps = performanceFunnel.steps || [];
    const startStep = steps[0];
    const endStep = steps[steps.length - 1];
    const reachStart = startStep ? startStep.reach : 0;
    const reachEnd = endStep ? endStep.reach : 0;
    const globalConversion = reachStart > 0 ? ((reachEnd / reachStart) * 100).toFixed(2) : '0.00';
    const totalDropOff = (100 - parseFloat(globalConversion)).toFixed(2);

    // Calculate bottlenecks (find the largest relative drop-off)
    let maxDropoffPct = 0;
    let bottleneckStepIndex = -1;

    for (let i = 1; i < steps.length; i++) {
      const prevReach = steps[i - 1].reach;
      const currReach = steps[i].reach;
      if (prevReach > 0) {
        const dropoff = ((prevReach - currReach) / prevReach) * 100;
        if (dropoff > maxDropoffPct) {
          maxDropoffPct = dropoff;
          bottleneckStepIndex = i;
        }
      }
    }

    return (
      <LiveDataBoundary states={[funnelsLive, statsLive]} empty={false} label="Desempenho do funil">
      <div id="funnel-performance-detail" className="space-y-6 animate-fadeIn">
        
        {/* Navigation Breadcrumb & Back action */}
        <div className="flex items-center justify-between">
          <button 
            onClick={() => setSelectedPerformanceFunnelId(null)}
            className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors bg-white px-3.5 py-2 rounded-xl border border-slate-100 hover:border-slate-200 shadow-2xs cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 text-slate-400" />
            <span>Voltar para Pipelines</span>
          </button>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => onEditFunnel(performanceFunnel.id)}
              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Edit className="w-3.5 h-3.5 text-slate-500" />
              <span>Editar Estrutura</span>
            </button>
            <span className={`px-3 py-1 rounded-full text-xs font-bold font-mono uppercase tracking-wider ${
              performanceFunnel.status === 'active' 
                ? 'bg-emerald-100 text-emerald-800' 
                : performanceFunnel.status === 'inactive' 
                ? 'bg-slate-200 text-slate-600' 
                : 'bg-amber-100 text-amber-800'
            }`}>
              {performanceFunnel.status}
            </span>
          </div>
        </div>

        {/* Header Block */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100/80 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-slate-400 text-xs font-mono">
              <BarChart2 className="w-4 h-4 text-teal-500" />
              <span>PERFORMANCE & DROP-OFF AUDIT</span>
              <span>•</span>
              <span>{performanceFunnel.updatedTime}</span>
            </div>
            <h2 className="text-xl font-bold text-slate-800 tracking-tight mt-1">{performanceFunnel.name}</h2>
            <p className="text-xs text-slate-500 mt-1">Análise granular de micro-conversões baseada em rastreamento nativo e dados de pixels integrados.</p>
          </div>

          {/* Sparkline in Header */}
          {performanceFunnel.sparklineData && performanceFunnel.sparklineData.length > 0 && (
            <div className="bg-slate-50/50 p-3 rounded-xl border border-slate-100/60 flex items-center gap-4">
              <div className="text-right">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold block">Trend de Conversão</span>
                <span className="text-xs font-bold text-teal-600 font-mono">Últimos 7 dias</span>
              </div>
              <div className="w-24 h-10 shrink-0">
                <svg className="w-full h-full text-teal-500 overflow-visible" viewBox="0 0 100 20" preserveAspectRatio="none">
                  <path 
                    d={performanceFunnel.sparklineData.reduce((acc, curr, idx) => {
                      const x = (idx / (performanceFunnel.sparklineData.length - 1)) * 100;
                      const y = 20 - (curr / 40) * 18;
                      return acc + ` ${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
                    }, '')}
                    fill="none" 
                    stroke="currentColor" 
                    strokeWidth="2" 
                    strokeLinecap="round" 
                  />
                </svg>
              </div>
            </div>
          )}
        </div>

        {/* High-level performance cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-2xs">
            <div className="flex items-center gap-2 text-slate-400 mb-1">
              <Users className="w-4 h-4 text-slate-400" />
              <span className="text-[10px] font-mono uppercase font-semibold">Volume de Entrada</span>
            </div>
            <h3 className="text-lg font-bold text-slate-800 font-mono">{reachStart.toLocaleString()}</h3>
            <span className="text-[10px] text-slate-400 block mt-0.5">Audiência inicial no Step 1</span>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-2xs">
            <div className="flex items-center gap-2 text-slate-400 mb-1">
              <CheckCircle className="w-4 h-4 text-emerald-500" />
              <span className="text-[10px] font-mono uppercase font-semibold">Conversão Final</span>
            </div>
            <h3 className="text-lg font-bold text-slate-800 font-mono">{reachEnd.toLocaleString()}</h3>
            <span className="text-[10px] text-slate-400 block mt-0.5">Usuários que concluíram o funil</span>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-2xs">
            <div className="flex items-center gap-2 text-slate-400 mb-1">
              <Percent className="w-4 h-4 text-teal-500" />
              <span className="text-[10px] font-mono uppercase font-semibold">Taxa Global de Conversão</span>
            </div>
            <h3 className="text-lg font-bold text-teal-600 font-mono">{globalConversion}%</h3>
            <span className="text-[10px] text-slate-400 block mt-0.5">Média ponderada do fluxo</span>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-2xs">
            <div className="flex items-center gap-2 text-slate-400 mb-1">
              <TrendingDown className="w-4 h-4 text-rose-500" />
              <span className="text-[10px] font-mono uppercase font-semibold">Taxa Total de Abandono</span>
            </div>
            <h3 className="text-lg font-bold text-rose-500 font-mono">{totalDropOff}%</h3>
            <span className="text-[10px] text-slate-400 block mt-0.5">Tráfego que abandonou a jornada</span>
          </div>
        </div>

        {/* Master layout grid (Performance visualizer + Sidebar Audit) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Area: Funnel step flow progress */}
          <div className="lg:col-span-8 space-y-4">
            
            <div className="bg-white rounded-2xl border border-slate-100 p-6 shadow-2xs">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono mb-6">Mapeamento Seqüencial de Cliques</h3>

              {steps.length === 0 ? (
                <div className="text-center py-10 space-y-3">
                  <AlertCircle className="w-10 h-10 text-amber-500 mx-auto" />
                  <p className="text-xs text-slate-600 font-semibold">Nenhum step configurado para este funil de marketing.</p>
                  <button
                    onClick={() => onEditFunnel(performanceFunnel.id)}
                    className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-xs font-bold"
                  >
                    Adicionar Passo Agora
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  {steps.map((step, idx) => {
                    const prevStep = idx > 0 ? steps[idx - 1] : null;
                    const reachRatioFromStart = reachStart > 0 ? (step.reach / reachStart) * 100 : 0;
                    
                    // Conversion rate relative to the previous step
                    const relativeConvRate = prevStep && prevStep.reach > 0 
                      ? ((step.reach / prevStep.reach) * 100).toFixed(1) 
                      : '100.0';
                    const relativeDropoff = prevStep ? (100 - parseFloat(relativeConvRate)).toFixed(1) : '0.0';

                    const isBottleneck = idx === bottleneckStepIndex;

                    return (
                      <div key={step.id} className="relative">
                        
                        {/* Connecting Line with Drop-off rate in between */}
                        {idx > 0 && (
                          <div className="pl-14 my-2 flex items-center gap-4">
                            <div className="w-0.5 h-10 bg-slate-100 flex items-center justify-center relative">
                              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white px-2 py-0.5 border border-slate-150 rounded-md text-[9px] font-mono font-bold text-slate-500 whitespace-nowrap">
                                <ArrowDown className="w-2.5 h-2.5 inline mr-0.5 text-slate-400" />
                                {relativeConvRate}% de retenção
                              </div>
                            </div>
                            
                            {/* Drop-off tag marker */}
                            <div className={`text-[10px] font-mono px-2 py-1 rounded-md border flex items-center gap-1 ${
                              isBottleneck 
                                ? 'bg-red-50 text-red-600 border-red-100 font-bold' 
                                : 'bg-slate-50 text-slate-500 border-slate-100'
                            }`}>
                              <TrendingDown className={`w-3.5 h-3.5 ${isBottleneck ? 'text-red-500 animate-bounce' : 'text-slate-400'}`} />
                              <span>Perda: <b className={isBottleneck ? 'text-red-700' : 'text-slate-700'}>{relativeDropoff}%</b></span>
                              {isBottleneck && (
                                <span className="bg-red-500 text-white text-[8px] px-1 py-0.2 rounded-sm font-bold animate-pulse uppercase">Maior Gargalo</span>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Step Card */}
                        <div className={`p-4 rounded-xl border transition-all flex items-center justify-between gap-4 ${
                          isBottleneck 
                            ? 'bg-rose-50/10 border-rose-200/60 shadow-2xs' 
                            : 'bg-white border-slate-150/80 hover:border-slate-200'
                        }`}>
                          
                          {/* Left contents */}
                          <div className="flex items-center gap-4 min-w-0">
                            {/* Step badge */}
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 ${
                              isBottleneck
                                ? 'bg-red-100 text-red-700'
                                : 'bg-slate-100 text-slate-700'
                            }`}>
                              #{step.stepNumber}
                            </div>

                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <h4 className="text-xs font-bold text-slate-800 truncate">{step.name}</h4>
                                <span className="px-1.5 py-0.2 bg-teal-50 text-teal-800 text-[9px] font-mono rounded-sm border border-teal-100/50">
                                  {step.eventType}
                                </span>
                              </div>
                              
                              {/* Conditions summary */}
                              {step.conditions && step.conditions.length > 0 ? (
                                <div className="flex items-center gap-1.5 mt-1">
                                  <span className="text-[9px] font-mono text-slate-400">Trigger:</span>
                                  {step.conditions.map((c) => (
                                    <span key={c.id} className="text-[9px] bg-slate-50 border border-slate-100 text-slate-600 px-1 py-0.2 rounded-xs font-mono">
                                      {c.field} {c.operator === 'equals' ? '=' : c.operator} "{c.value}"
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-[10px] text-slate-400 block mt-0.5">Captura de pixel automática (sem UTMs restritivas)</span>
                              )}
                            </div>
                          </div>

                          {/* Center bar indicator */}
                          <div className="hidden md:block flex-1 max-w-[150px] space-y-1 text-right">
                            <div className="flex justify-between text-[9px] font-mono text-slate-400">
                              <span>Retenção Total</span>
                              <span>{reachRatioFromStart.toFixed(1)}%</span>
                            </div>
                            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-linear-to-r from-teal-500 to-emerald-500" 
                                style={{ width: `${reachRatioFromStart}%` }}
                              />
                            </div>
                          </div>

                          {/* Right side stats */}
                          <div className="text-right shrink-0">
                            <span className="text-[10px] text-slate-400 font-mono block">Visitantes Únicos</span>
                            <span className="text-xs font-bold text-slate-800 font-mono">{step.reach.toLocaleString()}</span>
                          </div>

                        </div>

                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Area: Dynamic Botleneck Diagnosis & AI Panel */}
          <div className="lg:col-span-4 space-y-4">
            
            {/* AI Diagnostics Box */}
            <div className="bg-slate-900 text-slate-100 rounded-2xl p-5 border border-slate-800 shadow-md relative overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-teal-500/10 rounded-full blur-xl pointer-events-none" />
              
              <div className="flex items-center gap-2 text-teal-400">
                <Sparkles className="w-5 h-5" />
                <span className="text-xs font-bold uppercase tracking-wider font-mono">Truvo AI Audit</span>
              </div>

              {bottleneckStepIndex !== -1 ? (
                <div className="mt-4 space-y-4 text-xs">
                  <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/50 space-y-1">
                    <span className="text-[9px] text-slate-400 font-mono uppercase block">Maior Perda de Conversão</span>
                    <h4 className="font-bold text-red-300">
                      Step #{steps[bottleneckStepIndex - 1].stepNumber} → Step #{steps[bottleneckStepIndex].stepNumber}
                    </h4>
                    <p className="text-slate-300 text-[11px] mt-1 leading-relaxed">
                      O maior abandono de tráfego ocorre de <b className="text-white">{steps[bottleneckStepIndex - 1].name}</b> para <b className="text-white">{steps[bottleneckStepIndex].name}</b>, com perda acumulada de <span className="text-red-400 font-bold font-mono">{maxDropoffPct.toFixed(1)}%</span> dos visitantes nesta transição.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <h5 className="font-semibold text-teal-300 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                      <span>Diagnóstico Recomendado:</span>
                    </h5>
                    
                    <ul className="space-y-2.5 text-[11px] text-slate-300 list-disc list-inside">
                      {performanceFunnel.id === 'ecommerce-main' && (
                        <>
                          <li><b>Instabilidade no checkout:</b> O pixel acusa 73.3% de perda entre Add to Cart e Purchase. Avalie as opções de frete ou checkout sem cadastro obrigatório.</li>
                          <li><b>Inconsistência de Preço:</b> O preço exibido no carrinho pode diferir de taxas finais de envio gerando atrito no fechamento.</li>
                          <li><b>Script Shopify lento:</b> Verifique o tempo de carregamento da rota de pagamento.</li>
                        </>
                      )}
                      {performanceFunnel.id === 'saas-onboarding' && (
                        <>
                          <li><b>Etapa burocrática:</b> O formulário de preenchimento tem uma perda inicial de 50%. Tente reduzir os campos obrigatórios na assinatura de teste.</li>
                          <li><b>Verificação de e-mail lenta:</b> Envie lembretes automáticos em até 3 minutos para resgatar leads perdidos.</li>
                        </>
                      )}
                      {performanceFunnel.id !== 'ecommerce-main' && performanceFunnel.id !== 'saas-onboarding' && (
                        <>
                          <li><b>Alinhamento do anúncio:</b> Certifique-se de que a promessa criativa da publicidade esteja claramente espelhada no título do seu destino de destino.</li>
                          <li><b>Otimização Mobile:</b> Cerca de 82% das perdas ocorrem em dispositivos móveis. Verifique compatibilidade de layout responsivo.</li>
                          <li><b>Aceleração de Imagens:</b> Comprimir banners de alta resolução para agilizar o carregamento em redes móveis 4G.</li>
                        </>
                      )}
                    </ul>
                  </div>

                  <div className="pt-3 border-t border-slate-800 text-[10px] text-slate-400 leading-relaxed italic">
                    💡 Dica: Sincronize o pixel com campanhas de Retargeting focando especificamente nas pessoas que abandonaram no step de transição.
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-300 mt-3 leading-relaxed">
                  Não há steps sucessivos suficientes com dados de cliques para diagnosticar gargalos. Adicione pelo menos dois passos ativos com tráfego mapeado para iniciar a análise inteligente Truvo AI.
                </p>
              )}
            </div>

            {/* Attribution Window and Filters Context Panel */}
            {!isLive && (
            <div className="bg-white rounded-2xl border border-slate-100 p-5 shadow-2xs space-y-3">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-1.5">
                <Info className="w-4 h-4 text-slate-400" />
                <span>Configuração de Escopo</span>
              </h4>
              
              <div className="space-y-2.5 text-xs text-slate-600">
                <div className="flex justify-between border-b border-slate-50 pb-2">
                  <span className="text-slate-400">Modelo Attribution:</span>
                  <span className="font-bold text-slate-800">Truvo ML Graph (AI)</span>
                </div>
                <div className="flex justify-between border-b border-slate-50 pb-2">
                  <span className="text-slate-400">Janela de Lookback:</span>
                  <span className="font-semibold text-slate-800">7-Day Click / 1-Day View</span>
                </div>
                <div className="flex justify-between border-b border-slate-50 pb-2">
                  <span className="text-slate-400">Canal Shopify Sync:</span>
                  <span className="text-emerald-600 font-bold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Ativo (Real-time)
                  </span>
                </div>
              </div>
            </div>
            )}

          </div>

        </div>

        {/* Attribution Analyzer Section */}
        {isLive ? (
          <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
            O detalhamento por canal, campanha e criativo ainda não está disponível para este funil ao vivo. Os números acima vêm exclusivamente do endpoint de estatísticas do funil.
          </div>
        ) : (
        <>
        <div id="attribution-analyzer-card" className="bg-white rounded-2xl border border-slate-100 p-6 shadow-2xs space-y-6 mt-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 border-b border-slate-50 pb-5">
            <div>
              <div className="flex items-center gap-2 text-teal-600 text-[10px] font-mono font-bold uppercase tracking-wider">
                <Shuffle className="w-3.5 h-3.5" />
                <span>Attribution Analyzer</span>
              </div>
              <h3 className="text-base font-bold text-slate-800 tracking-tight mt-1">Desempenho de Conversão por Canal de Aquisição</h3>
              <p className="text-xs text-slate-500 mt-1">Selecione um modelo de atribuição para entender a jornada e a real contribuição de cada canal no funil.</p>
            </div>

            {/* Model Toggle Buttons */}
            <div className="flex flex-wrap items-center gap-1.5 bg-slate-50 p-1.5 rounded-xl border border-slate-100/80 self-start lg:self-auto">
              {[
                { id: 'truvo_ml', label: 'Truvo AI Graph', premium: true },
                { id: 'first_click', label: 'Primeiro Clique', premium: false },
                { id: 'last_click', label: 'Último Clique', premium: false },
                { id: 'linear', label: 'Linear', premium: false },
              ].map((model) => (
                <button
                  key={model.id}
                  onClick={() => setSelectedModel(model.id as any)}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                    selectedModel === model.id
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                  }`}
                >
                  {model.premium && <Sparkles className="w-3 h-3 text-teal-400 fill-teal-400" />}
                  <span>{model.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Model Explanation Banner */}
          <div className="bg-slate-50/60 p-4 rounded-xl border border-slate-100/80 flex items-start gap-3 text-xs text-slate-600">
            <Info className="w-4.5 h-4.5 text-teal-500 shrink-0 mt-0.5" />
            <div>
              {selectedModel === 'truvo_ml' && (
                <span><b>Modelo Truvo AI Graph (Recomendado)</b>: Algoritmo baseado em grafos que analisa toda a jornada do cliente. Redistribui o valor de forma justa entre todos os pontos de contato, corrigindo a subnotificação do Meta e TikTok causada pelo iOS 14.</span>
              )}
              {selectedModel === 'first_click' && (
                <span><b>Modelo de Primeiro Clique</b>: Atribui 100% da conversão ao canal que introduziu o cliente à sua marca. Excelente para medir canais de atração/topo de funil, mas negligencia ações de remarketing.</span>
              )}
              {selectedModel === 'last_click' && (
                <span><b>Modelo de Último Clique (Padrão das plataformas)</b>: Atribui 100% do crédito ao último canal tocado antes da conversão. Supervaloriza canais de marca no Google Search, Direct e Email, mascarando a eficácia do tráfego pago frio.</span>
              )}
              {selectedModel === 'linear' && (
                <span><b>Modelo Linear</b>: Distribui o crédito de conversão igualmente para cada ponto de contato da jornada. Fornece uma visão equilibrada do ecossistema de marketing, embora não identifique canais decisivos individuais.</span>
              )}
            </div>
          </div>

          {/* Attribution Analyzer Breadcrumb/Navigation & Table */}
          {selectedChannel && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-100/80 mb-2">
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

          {/* Channels / Campaigns Data Table */}
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">
                  <th className="pb-3 font-semibold">{selectedChannel ? 'Campanha / Conjunto / Criativo' : 'Canal'}</th>
                  <th className="pb-3 text-right font-semibold">Investimento</th>
                  <th className="pb-3 text-right font-semibold">Visitantes</th>
                  <th className="pb-3 text-right font-semibold">Conversões Atribuídas</th>
                  <th className="pb-3 text-right font-semibold">Taxa de Conversão</th>
                  <th className="pb-3 text-right font-semibold">CPA / CAC</th>
                  <th className="pb-3 text-right font-semibold">ROAS Declarado</th>
                  <th className="pb-3 text-right font-semibold bg-teal-50/40 text-teal-800 px-3 rounded-t-lg">ROAS Atribuído</th>
                  <th className="pb-3 text-right font-semibold">Lift de Performance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-xs">
                {!selectedChannel ? (
                  // Top-Level Channels View
                  getChannelData(performanceFunnel.id, reachStart, reachEnd, selectedModel).map((ch) => {
                    const hasSpend = ch.spend > 0;
                    const hasRoas = ch.reportedRoas > 0;
                    
                    // Compute Lift/Difference percentage
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
                        className="hover:bg-slate-50/70 transition-colors cursor-pointer group"
                      >
                        {/* Channel Column */}
                        <td className="py-3.5 font-bold text-slate-800 flex items-center gap-2.5">
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
                            <span className="text-[10px] text-slate-400 font-mono font-medium uppercase block mt-0.5">
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
                        <td className="py-3.5 text-right font-mono font-bold text-slate-800">
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
                        <td className="py-3.5 text-right">
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
                  // Drilled-down view for selected channel
                  (() => {
                    const chData = getChannelData(performanceFunnel.id, reachStart, reachEnd, selectedModel).find(c => c.channel === selectedChannel);
                    if (!chData) return null;
                    
                    const campaigns = getCampaignData(performanceFunnel.id, selectedChannel, chData);
                    
                    return campaigns.map((c) => {
                      const isCExpanded = expandedCampaign === c.utm_campaign;
                      const cHasSpend = c.spend > 0;
                      const cHasRoas = c.reportedRoas > 0;
                      let cLiftPct = 0;
                      if (cHasRoas && c.modelRoas > 0) {
                        cLiftPct = ((c.modelRoas - c.reportedRoas) / c.reportedRoas) * 100;
                      }

                      return (
                        <React.Fragment key={c.utm_campaign}>
                          {/* Campaign Row */}
                          <tr 
                            onClick={() => {
                              setExpandedCampaign(isCExpanded ? null : c.utm_campaign);
                              setExpandedAdSet(null);
                            }}
                            className={`hover:bg-slate-50/80 transition-colors cursor-pointer border-l-4 ${isCExpanded ? 'border-teal-500 bg-slate-50/30' : 'border-transparent'}`}
                          >
                            <td className="py-3.5 font-bold text-slate-800 pl-4 flex items-center gap-2">
                              <div className="w-5 h-5 flex items-center justify-center text-slate-400 shrink-0">
                                {isCExpanded ? <ChevronDown className="w-4 h-4 text-teal-600" /> : <ChevronRight className="w-4 h-4" />}
                              </div>
                              <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                              <div className="min-w-0">
                                <span className="block truncate text-[12.5px]" title={c.utm_campaign}>{c.utm_campaign}</span>
                                <span className="text-[9px] text-slate-400 font-mono font-medium uppercase tracking-wider mt-0.5 block">
                                  CAMPANHA (utm_campaign)
                                </span>
                              </div>
                            </td>
                            
                            <td className="py-3.5 text-right font-mono font-semibold text-slate-700">
                              {cHasSpend ? `$${c.spend.toLocaleString()}` : <span className="text-slate-300">-</span>}
                            </td>

                            <td className="py-3.5 text-right font-mono text-slate-600">
                              {c.visitors.toLocaleString()}
                            </td>

                            <td className="py-3.5 text-right font-mono font-bold text-slate-800">
                              {c.conversions.toLocaleString()}
                            </td>

                            <td className="py-3.5 text-right font-mono text-slate-600">
                              {c.convRate}%
                            </td>

                            <td className="py-3.5 text-right font-mono text-slate-700">
                              {cHasSpend ? `$${c.cpa.toFixed(2)}` : <span className="text-emerald-600 font-semibold text-[11px]">Orgânico</span>}
                            </td>

                            <td className="py-3.5 text-right font-mono text-slate-500">
                              {cHasRoas ? `${c.reportedRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                            </td>

                            <td className="py-3.5 text-right font-mono font-bold text-teal-700 bg-teal-50/20 px-3">
                              {c.modelRoas > 0 ? `${c.modelRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                            </td>

                            <td className="py-3.5 text-right">
                              {cHasRoas && c.modelRoas > 0 ? (
                                <div className={`inline-flex items-center gap-0.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono ${
                                  cLiftPct >= 0 
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                                    : 'bg-rose-50 text-rose-700 border border-rose-100'
                                }`}>
                                  {cLiftPct >= 0 ? `+${cLiftPct.toFixed(1)}%` : `${cLiftPct.toFixed(1)}%`}
                                </div>
                              ) : (
                                <span className="text-slate-400 font-mono text-[10px]">-</span>
                              )}
                            </td>
                          </tr>

                          {/* Ad Sets Row List */}
                          {isCExpanded && c.adSets.map((as) => {
                            const isAsExpanded = expandedAdSet === as.term;
                            const asHasSpend = as.spend > 0;
                            const asHasRoas = as.reportedRoas > 0;
                            let asLiftPct = 0;
                            if (asHasRoas && as.modelRoas > 0) {
                              asLiftPct = ((as.modelRoas - as.reportedRoas) / as.reportedRoas) * 100;
                            }

                            return (
                              <React.Fragment key={as.term}>
                                <tr 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedAdSet(isAsExpanded ? null : as.term);
                                  }}
                                  className={`hover:bg-slate-50/90 transition-colors cursor-pointer bg-slate-50/40 border-l-4 ${isAsExpanded ? 'border-indigo-400 bg-indigo-50/10' : 'border-slate-200'}`}
                                >
                                  <td className="py-3 pl-10 font-medium text-slate-700 flex items-center gap-2">
                                    <div className="w-5 h-5 flex items-center justify-center text-slate-400 shrink-0">
                                      {isAsExpanded ? <ChevronDown className="w-3.5 h-3.5 text-indigo-500" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                    </div>
                                    <Tag className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                                    <div className="min-w-0">
                                      <span className="block truncate text-[12px] text-slate-800" title={as.term}>{as.term}</span>
                                      <span className="text-[8px] text-slate-400 font-mono font-bold uppercase tracking-wider block mt-0.5">
                                        CONJUNTO DE ANÚNCIOS (term)
                                      </span>
                                    </div>
                                  </td>

                                  <td className="py-3 text-right font-mono text-slate-600">
                                    {asHasSpend ? `$${as.spend.toLocaleString()}` : <span className="text-slate-300">-</span>}
                                  </td>

                                  <td className="py-3 text-right font-mono text-slate-500">
                                    {as.visitors.toLocaleString()}
                                  </td>

                                  <td className="py-3 text-right font-mono font-semibold text-slate-700">
                                    {as.conversions.toLocaleString()}
                                  </td>

                                  <td className="py-3 text-right font-mono text-slate-500">
                                    {as.convRate}%
                                  </td>

                                  <td className="py-3 text-right font-mono text-slate-600">
                                    {asHasSpend ? `$${as.cpa.toFixed(2)}` : <span className="text-emerald-600 font-medium text-[10px]">Orgânico</span>}
                                  </td>

                                  <td className="py-3 text-right font-mono text-slate-400">
                                    {asHasRoas ? `${as.reportedRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                                  </td>

                                  <td className="py-3 text-right font-mono font-bold text-indigo-700 bg-indigo-50/20 px-3">
                                    {as.modelRoas > 0 ? `${as.modelRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                                  </td>

                                  <td className="py-3 text-right">
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

                                {/* Creatives Row List */}
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
                                      className="bg-slate-50/70 hover:bg-slate-100/40 transition-colors border-l-4 border-slate-300 cursor-pointer"
                                    >
                                      <td className="py-2.5 pl-20 font-normal text-slate-600 flex items-center gap-2">
                                        <div className="w-5 shrink-0" />
                                        <PlaySquare className="w-3.5 h-3.5 text-pink-500 shrink-0" />
                                        <div className="min-w-0">
                                          <span className="block truncate text-[11px] text-slate-700 font-medium" title={cr.content}>{cr.content}</span>
                                          <span className="text-[8px] text-slate-400 font-mono font-bold uppercase tracking-wider block mt-0.5">
                                            CRIATIVO (content)
                                          </span>
                                        </div>
                                      </td>

                                      <td className="py-2.5 text-right font-mono text-slate-500">
                                        {crHasSpend ? `$${cr.spend.toLocaleString()}` : <span className="text-slate-300">-</span>}
                                      </td>

                                      <td className="py-2.5 text-right font-mono text-slate-400">
                                        {cr.visitors.toLocaleString()}
                                      </td>

                                      <td className="py-2.5 text-right font-mono text-slate-600">
                                        {cr.conversions.toLocaleString()}
                                      </td>

                                      <td className="py-2.5 text-right font-mono text-slate-400">
                                        {cr.convRate}%
                                      </td>

                                      <td className="py-2.5 text-right font-mono text-slate-500">
                                        {crHasSpend ? `$${cr.cpa.toFixed(2)}` : <span className="text-emerald-600 text-[10px]">Orgânico</span>}
                                      </td>

                                      <td className="py-2.5 text-right font-mono text-slate-400">
                                        {crHasRoas ? `${cr.reportedRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                                      </td>

                                      <td className="py-2.5 text-right font-mono font-semibold text-pink-700 bg-pink-50/20 px-3">
                                        {cr.modelRoas > 0 ? `${cr.modelRoas.toFixed(2)}x` : <span className="text-slate-300">-</span>}
                                      </td>

                                      <td className="py-2.5 text-right">
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

          {/* Micro Footer tip */}
          <div className="bg-slate-50/40 p-3.5 rounded-xl border border-slate-100/80 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-500 font-sans">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-ping shrink-0" />
              <span>Cruzamento de UTMs e cliques rastreados sincronizados com a API de dados Truvo.</span>
            </div>
            <span className="text-[9px] font-mono text-teal-600 font-bold tracking-wider">TRUVO MULTI-TOUCH ENGINE</span>
          </div>
        </div>

        {/* Creative Performance Modal */}
        {/* TODO(live): modal de criativo segue no mock — via /v1/attribution */}
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
            <div id="creative-metrics-modal" className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs z-50 flex items-center justify-center p-4 overflow-y-auto">
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
                        <span>{selectedChannel?.split(' ')[0]}</span>
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
                          <span className="block text-[10px] font-bold text-slate-200 leading-tight">Truvo Partner Ad</span>
                          <span className="block text-[8px] text-slate-400 leading-tight">Patrocinado • {selectedChannel}</span>
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
                        <p className="text-sm font-bold text-slate-800 mt-1 font-mono text-teal-700">
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
                          <p className="text-[8px] text-slate-400">Notificado no Gerenciador</p>
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
                          <p className="text-[8px] text-teal-600">Calculado via Multi-Touch Graph</p>
                        </div>
                      </div>

                      {/* Lift percentage bar and helper */}
                      {liftPct > 0 && (
                        <div className="bg-emerald-50 border border-emerald-100/50 p-2.5 rounded-lg flex items-center justify-between text-[11px] text-emerald-800">
                          <span className="font-semibold">Aumento de Visibilidade:</span>
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
        </>
        )}

      </div>
      </LiveDataBoundary>
    );
  }

  return (
    <LiveDataBoundary states={[funnelsLive]} empty={funnels.length === 0} label="Funis">
    <div id="funnels-view-container" className="space-y-6">
      {/* Page Header Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Pipelines de Conversão</h2>
          <p className="text-xs text-slate-500 mt-1 font-sans">
            Configure jornadas sequenciais para isolar e otimizar gargalos de cliques de tráfego. 
            <span className="text-teal-600 font-semibold ml-1">Clique em qualquer funil para ver o relatório detalhado de performance step-by-step.</span>
          </p>
        </div>
        <button
          onClick={onAddNewFunnel}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow-md shadow-teal-600/10 self-start cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Novo Funil de Conversão</span>
        </button>
      </div>

      {/* Metrics Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center gap-3">
          <div className="w-10 h-10 bg-teal-50 border border-teal-100 rounded-lg flex items-center justify-center text-teal-700 shrink-0">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-mono uppercase font-semibold">Total de Pipelines</span>
            <h4 className="text-lg font-bold text-slate-800">{totalFunnels} Funnels</h4>
          </div>
        </div>

        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-50 border border-emerald-100 rounded-lg flex items-center justify-center text-emerald-700 shrink-0">
            <Zap className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-mono uppercase font-semibold">Fluxos em Tempo Real</span>
            <h4 className="text-lg font-bold text-slate-800">{activeFunnels} Ativos</h4>
          </div>
        </div>

        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-50 border border-amber-100 rounded-lg flex items-center justify-center text-amber-700 shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-mono uppercase font-semibold">Média de Conversão Ativa</span>
            <h4 className="text-lg font-bold text-slate-800">{averageConversion}{isLive ? '' : '%'}</h4>
          </div>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="bg-white p-4 rounded-xl border border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Filtrar funis por nome..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-slate-150 rounded-xl bg-slate-50/50 text-xs text-slate-700 focus:bg-white focus:ring-1 focus:ring-teal-500 focus:border-teal-500 outline-none transition-all placeholder:text-slate-400 font-sans"
          />
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5">
          {(['all', 'active', 'inactive', 'draft'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setFilterStatus(status)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold capitalize font-mono transition-all cursor-pointer ${
                filterStatus === status
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {status === 'all' ? 'todos' : status}
            </button>
          ))}
        </div>
      </div>

      {/* Funnels Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {filteredFunnels.map((f) => {
          const startStep = f.steps && f.steps[0];
          const endStep = f.steps && f.steps[f.steps.length - 1];
          const reachStart = startStep ? startStep.reach : 0;
          const reachEnd = endStep ? endStep.reach : 0;
          const conversionPercent = reachStart > 0 ? ((reachEnd / reachStart) * 100).toFixed(1) : '0.0';

          return (
            <div 
              key={f.id} 
              onClick={() => setSelectedPerformanceFunnelId(f.id)}
              className="bg-white rounded-2xl border border-slate-150/85 hover:border-teal-300 p-5 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between cursor-pointer group hover:-translate-y-0.5 relative"
            >
              {/* Highlight helper on hover */}
              <div className="absolute top-3 right-16 opacity-0 group-hover:opacity-100 transition-opacity bg-teal-500/10 text-teal-700 font-bold text-[9px] px-1.5 py-0.5 rounded-sm flex items-center gap-0.5">
                <BarChart2 className="w-2.5 h-2.5" />
                <span>Ver performance</span>
              </div>

              {/* Card Header */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full sync-pulse ${f.status === 'active' ? 'bg-teal-500' : 'bg-slate-400'}`} />
                    <span className="text-[10px] font-mono text-slate-400 font-semibold">{f.updatedTime}</span>
                  </div>
                  
                  {/* Status click to toggle */}
                  <button
                    onClick={(e) => handleToggleStatus(f.id, e)}
                    className={`px-2 py-0.5 rounded-sm text-[9px] font-semibold font-mono uppercase tracking-wider transition-all hover:opacity-80 cursor-pointer ${
                      f.status === 'active'
                        ? 'bg-emerald-100 text-emerald-800'
                        : f.status === 'inactive'
                        ? 'bg-slate-200 text-slate-600'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                    title="Clique para alternar o status"
                  >
                    {f.status}
                  </button>
                </div>

                <h3 className="text-sm font-bold text-slate-800 tracking-tight mt-2 group-hover:text-teal-600 transition-colors">{f.name}</h3>
                
                {/* Steps Horizontal visualization */}
                <div className="mt-3 flex items-center gap-1.5 text-[11px] font-mono text-slate-500">
                  <BarChart2 className="w-3.5 h-3.5 text-slate-400" />
                  <span>{f.totalSteps} passos configurados</span>
                </div>

                {/* Micro Steps summary */}
                <div className="mt-3 bg-slate-50 p-2.5 rounded-xl border border-slate-100/60 text-[11px] font-sans text-slate-600">
                  {f.steps && f.steps.length > 0 ? (
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <span>Origem: <b className="text-slate-800 font-semibold">{startStep.name}</b></span>
                        <span className="font-mono text-[10px]">{isLive ? '—' : `${reachStart.toLocaleString()} visitors`}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Sucesso: <b className="text-slate-800 font-semibold">{endStep.name}</b></span>
                        <span className="font-mono text-[10px] text-teal-700">{isLive ? '—' : `${reachEnd.toLocaleString()} purchases`}</span>
                      </div>
                    </div>
                  ) : (
                    <span className="text-slate-400 italic block py-1 text-center">Nenhum passo definido. Clique para editar.</span>
                  )}
                </div>
              </div>

              {/* Sparkline & Rate Footer */}
              <div className="mt-5 pt-4 border-t border-slate-50 flex items-center justify-between gap-4">
                <div>
                  <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">Taxa de Conversão</span>
                  <div className="text-base font-bold text-slate-800 font-mono mt-0.5">
                    {isLive ? '—' : `${conversionPercent}%`}
                  </div>
                </div>

                {/* Mini SVG Sparkline */}
                {f.sparklineData && f.sparklineData.length > 0 && (
                  <div className="w-20 h-8">
                    <svg className="w-full h-full text-teal-500 overflow-visible" viewBox="0 0 100 20" preserveAspectRatio="none">
                      <path 
                        d={f.sparklineData.reduce((acc, curr, idx) => {
                          const x = (idx / (f.sparklineData.length - 1)) * 100;
                          const y = 20 - (curr / 40) * 18; // scaled
                          return acc + ` ${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
                        }, '')}
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="1.5" 
                        strokeLinecap="round" 
                      />
                    </svg>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="mt-4 pt-3 border-t border-slate-50 flex items-center justify-between gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditFunnel(f.id);
                  }}
                  className="flex-1 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-lg text-[10px] font-bold text-slate-700 hover:text-slate-900 transition-colors flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Edit className="w-3 h-3 text-slate-400" />
                  <span>Configurar Steps</span>
                </button>
                <button
                  onClick={(e) => handleDeleteFunnel(f.id, e)}
                  className="p-1.5 hover:bg-rose-50 hover:text-rose-600 border border-transparent hover:border-rose-100 text-slate-400 rounded-lg transition-colors cursor-pointer"
                  title="Excluir Funil"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}

        {/* Create Funnel Card Slot */}
        <button
          onClick={onAddNewFunnel}
          className="bg-slate-50/50 hover:bg-slate-50 border-2 border-dashed border-slate-200 hover:border-teal-400 rounded-2xl p-6 transition-all flex flex-col items-center justify-center text-center group cursor-pointer h-[290px]"
        >
          <div className="w-12 h-12 rounded-full bg-white group-hover:bg-teal-50 border border-slate-150 group-hover:border-teal-100 flex items-center justify-center text-slate-400 group-hover:text-teal-600 transition-all shadow-2xs">
            <Plus className="w-6 h-6" />
          </div>
          <h3 className="text-xs font-bold text-slate-700 group-hover:text-teal-900 mt-4 font-sans uppercase tracking-wider">Adicionar Canal Personalizado</h3>
          <p className="text-[10px] text-slate-400 max-w-[180px] mt-1.5 leading-normal">Mapeie cliques seqüenciais de tráfego, eventos integrados e UTMs customizadas de campanhas.</p>
        </button>
      </div>
    </div>
    </LiveDataBoundary>
  );
}
