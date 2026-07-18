import { SetMetadata } from '@nestjs/common';
import type { Feature } from './feature-gates';

/**
 * Metadata que marca a feature (gate de plano M11) exigida por uma rota.
 * Lida pelo {@link FeatureGuard}.
 */
export const FEATURE_KEY = 'truvo:feature';

/**
 * @RequireFeature('explorer_sql') — exige que o plano do workspace libere a
 * feature (e, para features role-gated, o papel owner/admin). Use em conjunto:
 *
 *   @UseGuards(SupabaseAuthGuard, WorkspaceGuard, FeatureGuard)
 *   @RequireFeature('ai_journey')
 *
 * O FeatureGuard roda DEPOIS do WorkspaceGuard (precisa de `request.workspace`).
 */
export const RequireFeature = (feature: Feature) => SetMetadata(FEATURE_KEY, feature);
