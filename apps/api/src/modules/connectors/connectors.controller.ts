import { Body, Controller, Get, HttpCode, Param, Post, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, Roles } from '../auth/decorators';
import { ConnectorConnectionService, type CreateConnectionInput } from './connector-connection.service';
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

  @Post('connections/:connectionId/backfill')
  @HttpCode(202)
  @Roles('owner', 'admin')
  triggerBackfill(@Param('id') workspaceId: string, @Param('connectionId') connectionId: string) {
    return this.orchestrator.runBackfill(workspaceId, connectionId);
  }

  @Post('connections/:connectionId/sync')
  @HttpCode(202)
  @Roles('owner', 'admin')
  triggerIncrementalSync(@Param('id') workspaceId: string, @Param('connectionId') connectionId: string) {
    return this.orchestrator.runIncremental(workspaceId, connectionId);
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
    const deliveryId = (headers['x-shopify-webhook-id'] as string | undefined) ?? undefined;
    const request: RawWebhookRequest = {
      headers,
      body: req.body,
      rawBody: req.rawBody,
      deliveryId,
    };
    return this.webhook.handleWebhook(workspaceId, connectionId, request);
  }
}
