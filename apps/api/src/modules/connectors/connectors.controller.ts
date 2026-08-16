import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, Roles } from '../auth/decorators';
import { ConnectorConnectionService, type CreateConnectionInput } from './connector-connection.service';
import { ConnectorRegistryService } from './connector-registry.service';
import { ConnectorSyncOrchestratorService } from './connector-sync-orchestrator.service';
import { ConnectorWebhookService } from './connector-webhook.service';
import type { RawWebhookRequest } from './contracts';

/**
 * Order 060 §2 — closes Order 050's deferred HTTP-surface decision: the minimum
 * provider-neutral routes needed to connect/operate a real source connector
 * (Shopify first, any future provider the same way). Reuses the EXACT auth
 * guards/decorators `DataLifecycleController` already establishes — no parallel
 * auth model, no general integrations-UI redesign (out of scope per the order).
 *
 * Deliberately thin: connection CRUD/testing/credential handling all already live
 * in `ConnectorConnectionService`; this controller only exposes them plus the two
 * sync-trigger endpoints and the public webhook receiver.
 */
@Controller('v1/workspaces/:id/connectors')
@UseGuards(SupabaseAuthGuard, WorkspaceGuard)
export class ConnectorsController {
  constructor(
    private readonly connections: ConnectorConnectionService,
    private readonly orchestrator: ConnectorSyncOrchestratorService,
    private readonly registry: ConnectorRegistryService,
  ) {}

  @Post('connections')
  @Roles('owner', 'admin')
  create(
    @Param('id') workspaceId: string,
    @Body() body: CreateConnectionInput,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.connections.create(workspaceId, body, user);
  }

  @Get('connections')
  @Roles('owner', 'admin')
  list(@Param('id') workspaceId: string) {
    return this.connections.list(workspaceId);
  }

  @Get('connections/:connectionId')
  @Roles('owner', 'admin')
  get(@Param('id') workspaceId: string, @Param('connectionId') connectionId: string) {
    return this.connections.get(workspaceId, connectionId);
  }

  @Post('connections/:connectionId/credentials')
  @Roles('owner', 'admin')
  setCredentials(
    @Param('id') workspaceId: string,
    @Param('connectionId') connectionId: string,
    @Body() credentials: Record<string, unknown>,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.connections.setCredentials(workspaceId, connectionId, credentials, user);
  }

  /** Tests credentials + scopes — separate from sync health per Order 060 §2. */
  @Post('connections/:connectionId/test')
  @Roles('owner', 'admin')
  test(
    @Param('id') workspaceId: string,
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.connections.testConnection(workspaceId, connectionId, user);
  }

  /** Order 061 — a provider may declare multiple independent
   * `ConnectorDefinition.incrementalStreams` (HubSpot: contacts/companies/deals),
   * each with its own checkpoint; absent → the single `['default']` stream every
   * other provider (Shopify) already uses. One result per stream. */
  @Post('connections/:connectionId/backfill')
  @HttpCode(202)
  @Roles('owner', 'admin')
  async triggerBackfill(@Param('id') workspaceId: string, @Param('connectionId') connectionId: string) {
    const streams = await this.streamsFor(workspaceId, connectionId);
    const results: Record<string, unknown> = {};
    for (const stream of streams) results[stream] = await this.orchestrator.runBackfill(workspaceId, connectionId, stream);
    return results;
  }

  @Post('connections/:connectionId/sync')
  @HttpCode(202)
  @Roles('owner', 'admin')
  async triggerIncrementalSync(@Param('id') workspaceId: string, @Param('connectionId') connectionId: string) {
    const streams = await this.streamsFor(workspaceId, connectionId);
    const results: Record<string, unknown> = {};
    for (const stream of streams) results[stream] = await this.orchestrator.runIncremental(workspaceId, connectionId, stream);
    return results;
  }

  private async streamsFor(workspaceId: string, connectionId: string): Promise<readonly string[]> {
    const connection = await this.connections.get(workspaceId, connectionId);
    return this.registry.getDefinition(connection.provider)?.incrementalStreams ?? ['default'];
  }

  @Post('connections/:connectionId/disconnect')
  @Roles('owner', 'admin')
  disconnect(
    @Param('id') workspaceId: string,
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.connections.disconnect(workspaceId, connectionId, user);
  }

  /** Order 061 §1 — "OAuth-style authorization through Connector Framework."
   * Provider-neutral: any `credentialKind: 'oauth'` adapter implementing
   * `getOAuthAuthorizeUrl`/`exchangeOAuthCode` (contracts.ts) gets this for free. */
  @Get('connections/:connectionId/oauth/authorize-url')
  @Roles('owner', 'admin')
  async getOAuthAuthorizeUrl(@Param('id') workspaceId: string, @Param('connectionId') connectionId: string, @Query('redirect_uri') redirectUri: string) {
    const connection = await this.connections.get(workspaceId, connectionId);
    const adapter = this.registry.getSourceAdapter(connection.provider);
    if (!adapter?.getOAuthAuthorizeUrl) throw new BadRequestException(`provider '${connection.provider}' não usa autorização OAuth`);
    return adapter.getOAuthAuthorizeUrl(connection, redirectUri);
  }

  @Post('connections/:connectionId/oauth/callback')
  @Roles('owner', 'admin')
  async oauthCallback(
    @Param('id') workspaceId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: { code: string; redirect_uri: string },
    @CurrentUser() user: { id: string; email?: string },
  ) {
    const connection = await this.connections.get(workspaceId, connectionId);
    const adapter = this.registry.getSourceAdapter(connection.provider);
    if (!adapter?.exchangeOAuthCode) throw new BadRequestException(`provider '${connection.provider}' não usa autorização OAuth`);
    const exchanged = await adapter.exchangeOAuthCode(connection, { code: body.code, redirectUri: body.redirect_uri });
    await this.connections.setCredentials(workspaceId, connectionId, exchanged.credentials, user);
    if (exchanged.connectionMetadata) await this.connections.updateConfig(workspaceId, connectionId, exchanged.connectionMetadata);
    return { ok: true, connectionMetadata: exchanged.connectionMetadata };
  }
}

/**
 * Public (no-JWT) webhook receiver — mirrors `WebhooksController`'s
 * `RawBodyRequest<Request>` pattern exactly. Workspace/connection are resolved
 * from the URL itself (this is a per-connection callback URL registered with the
 * provider), so no separate integration-lookup step is needed the way the M4
 * `WebhooksController` requires — Order 050's connection is already the identity.
 */
@Controller('v1/connectors/webhooks')
export class ConnectorWebhooksController {
  constructor(private readonly webhook: ConnectorWebhookService) {}

  @Post(':workspaceId/:connectionId')
  @HttpCode(200)
  receive(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') connectionId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const headers = Object.fromEntries(Object.entries(req.headers)) as Record<string, string | string[] | undefined>;
    const deliveryId = (headers['x-shopify-webhook-id'] ?? headers['x-hubspot-request-id']) as string | undefined;
    // Same `requestUrl` construction the legacy M4 `webhooks.service.ts` already
    // uses for HubSpot's v3 signature scheme (signs over METHOD+URL+BODY+TIMESTAMP)
    // — trusts the 1st proxy hop, matching `main.ts`'s `trust proxy` setting.
    const host = headers['host'] as string | undefined;
    const proto = (headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'https';
    const url = host && req.originalUrl ? `${proto}://${host}${req.originalUrl}` : undefined;
    const request: RawWebhookRequest = {
      headers,
      body: req.body,
      rawBody: req.rawBody,
      deliveryId,
      url,
      method: req.method,
    };
    return this.webhook.handleWebhook(workspaceId, connectionId, request);
  }
}
