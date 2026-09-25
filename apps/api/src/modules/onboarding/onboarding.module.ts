import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { DataQualityModule } from '../data-quality/data-quality.module';
import { RadarsModule } from '../radars/radars.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({ imports: [ConnectorsModule, DataQualityModule, RadarsModule], controllers: [OnboardingController], providers: [OnboardingService], exports: [OnboardingService] })
export class OnboardingModule {}
