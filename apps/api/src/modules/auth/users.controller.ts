import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { updateUserSchema, type UpdateUserDto } from './dto/user.dto';

@Controller('v1/users')
@UseGuards(SupabaseAuthGuard)
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get('me')
  me(@CurrentUser('id') userId: string) {
    return this.auth.getMe(userId);
  }

  @Patch('me')
  update(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(updateUserSchema)) dto: UpdateUserDto,
  ) {
    return this.auth.updateMe(userId, dto);
  }
}
