import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WorkspacesService } from './workspaces.service';
import { CurrentUser, Roles } from './decorators';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { WorkspaceGuard } from './guards/workspace.guard';
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  type CreateWorkspaceDto,
  type UpdateWorkspaceDto,
} from './dto/workspace.dto';
import {
  inviteSchema,
  updateMemberSchema,
  type InviteDto,
  type UpdateMemberDto,
} from './dto/member.dto';

/**
 * Workspaces CRUD + membros (PRD §7 M1).
 * SupabaseAuthGuard (autenticação) roda no controller; WorkspaceGuard
 * (autorização multi-tenant + @Roles) roda nas rotas com :id.
 */
@Controller('v1/workspaces')
@UseGuards(SupabaseAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.workspaces.listForUser(userId);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(createWorkspaceSchema)) dto: CreateWorkspaceDto,
  ) {
    return this.workspaces.createWorkspace(userId, dto);
  }

  @Get(':id')
  @UseGuards(WorkspaceGuard)
  get(@Param('id') id: string) {
    return this.workspaces.getById(id);
  }

  @Patch(':id')
  @UseGuards(WorkspaceGuard)
  @Roles('owner', 'admin')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWorkspaceSchema)) dto: UpdateWorkspaceDto,
  ) {
    return this.workspaces.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(WorkspaceGuard)
  @Roles('owner')
  remove(@Param('id') id: string, @CurrentUser() user: { id: string; email?: string }) {
    return this.workspaces.remove(id, user);
  }

  // ── Membros ──────────────────────────────────────────────────────────────
  @Get(':id/members')
  @UseGuards(WorkspaceGuard)
  members(@Param('id') id: string) {
    return this.workspaces.listMembers(id);
  }

  @Post(':id/invite')
  @HttpCode(201)
  @UseGuards(WorkspaceGuard)
  @Roles('owner', 'admin')
  invite(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(inviteSchema)) dto: InviteDto,
  ) {
    return this.workspaces.invite(id, userId, dto);
  }

  @Patch(':id/members/:userId')
  @UseGuards(WorkspaceGuard)
  @Roles('owner', 'admin')
  updateMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) dto: UpdateMemberDto,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.workspaces.updateMember(id, userId, dto, user);
  }

  @Delete(':id/members/:userId')
  @UseGuards(WorkspaceGuard)
  @Roles('owner', 'admin')
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: { id: string; email?: string },
  ) {
    return this.workspaces.removeMember(id, userId, user);
  }
}
