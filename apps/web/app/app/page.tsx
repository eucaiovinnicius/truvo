'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import DashboardView from '@/appui/components/DashboardView';
import { initialFunnels } from '@/appui/data';
import { useSession } from '@/lib/session';

export default function OverviewPage() {
  const session = useSession();
  const router = useRouter();
  const [dateRange, setDateRange] = useState('Last 7 Days');
  const funnels = session.mode === 'demo' ? initialFunnels : [];

  const handleSetView = (view: string) => {
    switch (view) {
      case 'radars':
        router.push('/app/radars');
        break;
      case 'opportunities':
      case 'revenue-opportunities':
        router.push('/app/opportunities');
        break;
      case 'integrations':
        router.push('/app/integrations');
        break;
      case 'profiles':
      case 'customers':
        router.push('/app/customers');
        break;
      case 'settings':
        router.push('/app/settings');
        break;
      case 'onboarding':
        router.push('/app/onboarding');
        break;
      default:
        router.push(`/app/${view}`);
        break;
    }
  };

  return (
    <div className="space-y-6">
      <DashboardView
        funnels={funnels}
        setView={handleSetView}
        dateRange={dateRange}
      />
    </div>
  );
}
