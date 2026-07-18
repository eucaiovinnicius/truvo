import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReportsService } from './reports.service';
import { publicReportQuerySchema, type PublicReportQueryDto } from './dto/report.dto';

/**
 * M13 — compartilhamento read-only de relatórios (link web). SEM auth e SEM guard de
 * workspace: o tenant é resolvido SERVER-SIDE pelo registro (via public_token de relatório
 * OU de execução), NUNCA a partir do request. Só tokens ativos resolvem; snapshot congelado.
 *
 * `?format=json` (default) devolve o payload estruturado; `?format=html` o HTML white-label;
 * `?format=pdf` o HTML pronto-para-impressão (binário é TODO(live)). Nunca expõe workspace_id.
 *
 * Registrado ANTES do ReportsController (ver reports.module.ts) para garantir que a rota
 * `public/:token` case antes das rotas com `:id`.
 */
@Controller('v1/reports')
export class PublicReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('public/:token')
  @Header('Cache-Control', 'private, max-age=60')
  publicView(
    @Param('token') token: string,
    @Query(new ZodValidationPipe(publicReportQuerySchema)) q: PublicReportQueryDto,
  ): Promise<unknown> {
    // Retornar string → Nest/Express responde text/html; objeto → application/json.
    return this.reports.renderPublic(token, q.format);
  }
}
