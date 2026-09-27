'use client';

import React from 'react';
import { FeatureUnavailableState } from '@/appui/components/ScreenStates';

export default function CatchAllAppPage({ params }: { params: { slug?: string[] } }) {
  const path = params.slug?.join('/') ?? '';
  return (
    <FeatureUnavailableState
      featureName={`Módulo /app/${path}`}
      description="Esta funcionalidade não está disponível no MVP do Truvo."
    />
  );
}
