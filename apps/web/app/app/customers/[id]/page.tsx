'use client';

import React from 'react';
import ProfilesView from '@/appui/components/ProfilesView';

export default function CustomerDetailPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-6">
      <ProfilesView initialCustomerId={params.id} />
    </div>
  );
}
