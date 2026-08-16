import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiKeysService } from './api-keys.service';
import { createApiKeySchema, type CreateApiKeyDto } from './dto/query.dto';
import type { AuthenticatedRequest } from './types';

/** CRUD de API keys do workspace (auth: JWT). */
@Controller('v1/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.apiKeys.list(req.workspaceId);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createApiKeySchema)) dto: CreateApiKeyDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.apiKeys.create(req.workspaceId, dto.name, req.user?.id, req.user?.email);
  }

  @Delete(':id')
  @HttpCode(200)
  revoke(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.apiKeys.revoke(req.workspaceId, id, req.user);
  }
}
