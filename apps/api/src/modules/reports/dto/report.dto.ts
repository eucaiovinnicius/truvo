import { z } from 'zod';
import type {
  ReportFormat,
  ReportFrequency,
  ReportTemplate,
} from '@truvo/db';
import {
  REPORT_PERIODS,
  REPORT_FREQUENCIES,
  REPORT_TEMPLATES,
  REPORT_FORMATS,
  HEX_COLOR_RE,
  type ReportPeriod,
} from '../reports.constants';

/**
 * DTOs do M13 (CRUD /v1/reports + /send). Toda validação via zod (ZodValidationPipe),
 * consistente com o restante do backend. Sem SQL do cliente: o relatório referencia um
 * `dashboard_id` (M6) e o snapshot é resolvido server-side.
 *
 * Os casts `as unknown as [Lit, ...Lit[]]` preservam a UNIÃO LITERAL na inferência do zod
 * (z.infer vira ReportFrequency/ReportTemplate/... e não `string`), o que casa com os
 * campos `$type<...>` do schema e evita casts no service.
 */

const periodEnum = z.enum(REPORT_PERIODS as unknown as [ReportPeriod, ...ReportPeriod[]]);
const frequencyEnum = z.enum(REPORT_FREQUENCIES as unknown as [ReportFrequency, ...ReportFrequency[]]);
const templateEnum = z.enum(REPORT_TEMPLATES as unknown as [ReportTemplate, ...ReportTemplate[]]);
const formatEnum = z.enum(REPORT_FORMATS as unknown as [ReportFormat, ...ReportFormat[]]);

const hex = z
  .string()
  .trim()
  .regex(HEX_COLOR_RE, 'cor deve ser hex (#rgb ou #rrggbb)');

const scheduleSchema = z
  .object({
    hour: z.number().int().min(0).max(23).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const brandingSchema = z
  .object({
    logoUrl: z.string().trim().url().max(2048).optional(),
    companyName: z.string().trim().max(160).optional(),
    primaryColor: hex.optional(),
    accentColor: hex.optional(),
    backgroundColor: hex.optional(),
    textColor: hex.optional(),
    domain: z.string().trim().max(253).optional(),
    footerText: z.string().trim().max(500).optional(),
  })
  .strict();

const recipientsSchema = z.array(z.string().trim().email()).max(50);

export const createReportSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    dashboard_id: z.string().trim().min(1).max(64),
    template: templateEnum.default('custom'),
    period: periodEnum.default('last_30_days'),
    frequency: frequencyEnum.default('manual'),
    schedule: scheduleSchema.optional(),
    recipients: recipientsSchema.default([]),
    branding: brandingSchema.optional(),
    /** Liga o agendamento imediatamente (só faz efeito com frequency != 'manual'). */
    enabled: z.boolean().default(false),
    /** Gera o token público (link web read-only) na criação. */
    is_public: z.boolean().default(false),
  })
  .strict();
export type CreateReportDto = z.infer<typeof createReportSchema>;

export const updateReportSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    dashboard_id: z.string().trim().min(1).max(64).optional(),
    template: templateEnum.optional(),
    period: periodEnum.optional(),
    frequency: frequencyEnum.optional(),
    schedule: scheduleSchema.optional(),
    recipients: recipientsSchema.optional(),
    branding: brandingSchema.optional(),
    enabled: z.boolean().optional(),
    /** Liga/desliga o compartilhamento read-only (gera/limpa public_token). */
    is_public: z.boolean().optional(),
  })
  .strict();
export type UpdateReportDto = z.infer<typeof updateReportSchema>;

/**
 * Corpo do POST /:id/send (envio manual/teste). Todos opcionais: sem eles, usa a config
 * salva do relatório. `recipients` aqui SOBRESCREVE a lista salva (útil p/ enviar um teste
 * a si mesmo). `format='email'` força o envio; 'web' só congela o snapshot e gera o link.
 */
export const sendReportSchema = z
  .object({
    format: formatEnum.default('web'),
    period: periodEnum.optional(),
    recipients: recipientsSchema.optional(),
  })
  .strict();
export type SendReportDto = z.infer<typeof sendReportSchema>;

/** Query de GET /:id/history. */
export const historyQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type HistoryQueryDto = z.infer<typeof historyQuerySchema>;

/**
 * Query do endpoint público. `format=html` devolve o HTML white-label renderizado.
 * NÃO é strict: links compartilhados costumam ganhar params de tracking (utm_*) coladas
 * por clientes de email — ignoramos o excedente em vez de rejeitar (400).
 */
export const publicReportQuerySchema = z.object({
  format: z.enum(['json', 'html', 'pdf']).default('json'),
});
export type PublicReportQueryDto = z.infer<typeof publicReportQuerySchema>;
