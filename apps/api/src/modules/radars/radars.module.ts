import { Module } from '@nestjs/common'; import { DataQualityModule } from '../data-quality/data-quality.module'; import { RadarsController } from './radars.controller'; import { RadarService } from './radar.service';
@Module({ imports:[DataQualityModule], controllers:[RadarsController], providers:[RadarService], exports:[RadarService] }) export class RadarsModule {}
