'use client';

import React, { type ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import AppGuard from '@/appui/components/AppGuard';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AppGuard>{children}</AppGuard>
    </SessionProvider>
  );
}
