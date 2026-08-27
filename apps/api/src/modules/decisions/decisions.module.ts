import { Module } from '@nestjs/common'; import { DecisionsService } from './decisions.service'; import { DecisionsController } from './decisions.controller';
@Module({controllers:[DecisionsController],providers:[DecisionsService],exports:[DecisionsService]}) export class DecisionsModule {}
