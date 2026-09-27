'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import OnboardingFlow from '@/appui/components/OnboardingFlow';
import { useSession } from '@/lib/session';

export default function OnboardingPage() {
  const session = useSession();
  const router = useRouter();
  const workspaceId = session.workspace?.id || 'truvo-global';

  const handleComplete = () => {
    router.push('/app/radars');
  };

  const handleCancel = () => {
    router.push('/app');
  };

  const handleOpenIntegrations = () => {
    router.push('/app/integrations');
  };

  return (
    <div className="py-2">
      <OnboardingFlow
        key={workspaceId}
        workspaceId={workspaceId}
        onComplete={handleComplete}
        onCancel={handleCancel}
        onOpenIntegrations={handleOpenIntegrations}
        showCancelButton={true}
      />
    </div>
  );
}
