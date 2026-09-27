'use client';

import React, { type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useSession } from '@/lib/session';
import { isRouteEnabled } from '@/lib/capabilities';
import AppShell from './AppShell';
import LoginView from './LoginView';
import {
  AppShellSkeleton,
  FeatureUnavailableState,
  NoWorkspaceState,
} from './ScreenStates';

export interface AppGuardProps {
  children: ReactNode;
}

export default function AppGuard({ children }: AppGuardProps) {
  const session = useSession();
  const pathname = usePathname() || '/app';

  // 1. Session hydrating state (never return null blank)
  if (!session.ready) {
    return <AppShellSkeleton />;
  }

  // 2. Unauthenticated state
  if (!session.mode) {
    return (
      <LoginView
        onLoginSuccess={(_profile, mode) => {
          if (mode === 'demo') {
            session.demo();
          }
        }}
      />
    );
  }

  // 3. Feature / route guard for disabled modules
  if (!isRouteEnabled(pathname)) {
    return (
      <AppShell>
        <FeatureUnavailableState />
      </AppShell>
    );
  }

  // 4. Authenticated Live with no workspace access
  if (session.isLive && !session.workspace && session.workspaces.length === 0) {
    return (
      <AppShell>
        <NoWorkspaceState />
      </AppShell>
    );
  }

  // 5. Valid session (live or demo)
  return <AppShell>{children}</AppShell>;
}
