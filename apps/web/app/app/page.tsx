'use client';

import React, { useState } from 'react';
import DashboardView from '@/appui/components/DashboardView';
import { initialFunnels } from '@/appui/data';
import { useSession } from '@/lib/session';

export default function OverviewPage() {
  const session = useSession();
  const [dateRange, setDateRange] = useState('Last 7 Days');
  const funnels = session.mode === 'demo' ? initialFunnels : [];

  return (
    <div className="space-y-6">
      <DashboardView
        funnels={funnels}
        setView={() => {}}
        dateRange={dateRange}
      />
    </div>
  );
}
