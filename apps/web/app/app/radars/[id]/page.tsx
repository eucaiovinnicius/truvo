'use client';

import React from 'react';
import RadarsView from '@/appui/components/RadarsView';

export default function RadarDetailPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-6">
      <RadarsView initialRadarId={params.id} initialScreen="detail" />
    </div>
  );
}
