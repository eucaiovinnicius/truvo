'use client';

import React, { use } from 'react';
import ProfilesView, { type CustomerSearchState, type SearchType } from '@/appui/components/ProfilesView';

interface CustomersPageProps {
  searchParams?: Promise<{ q?: string; type?: string }> | { q?: string; type?: string };
}

export default function CustomersPage({ searchParams }: CustomersPageProps) {
  const resolved = searchParams && typeof (searchParams as any).then === 'function'
    ? use(searchParams as Promise<{ q?: string; type?: string }>)
    : (searchParams as { q?: string; type?: string } | undefined);

  const initialSearch: CustomerSearchState | undefined = resolved?.q
    ? {
        q: resolved.q,
        type: (resolved.type as SearchType) || 'email',
      }
    : undefined;

  return (
    <div className="space-y-6">
      <ProfilesView initialSearch={initialSearch} />
    </div>
  );
}
