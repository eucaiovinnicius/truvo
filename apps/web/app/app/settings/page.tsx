'use client';

import React, { useState } from 'react';
import SettingsView from '@/appui/components/SettingsView';
import { useSession } from '@/lib/session';
import type { ProfileConfig, WorkspaceConfig } from '@/appui/types';

export default function SettingsPage() {
  const session = useSession();

  const [profile, setProfile] = useState<ProfileConfig>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('truvo_profile');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          // ignore
        }
      }
    }
    return {
      fullName: session.user?.name || session.user?.email || 'Alex Mercer',
      email: session.user?.email || 'alex@truvo.ai',
      avatarUrl: session.user?.avatar_url || '',
    };
  });

  const [workspace, setWorkspace] = useState<WorkspaceConfig>(() => ({
    name: session.workspace?.name || 'Truvo Global Store',
    slug: session.workspace?.id || 'truvo-global',
    timezone: 'America/New_York',
    currency: 'USD',
  }));

  return (
    <div className="space-y-6">
      <SettingsView
        profile={profile}
        setProfile={setProfile}
        workspace={
          session.isLive
            ? {
                ...workspace,
                name: session.workspace?.name || workspace.name,
                slug: session.workspace?.id || workspace.slug,
              }
            : workspace
        }
        setWorkspace={setWorkspace}
      />
    </div>
  );
}
