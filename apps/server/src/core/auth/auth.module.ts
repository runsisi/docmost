import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';
import { GiteaController } from './gitea/gitea.controller';
import { GiteaService } from './gitea/gitea.service';

@Module({
  imports: [TokenModule, WorkspaceModule],
  controllers: [AuthController, GiteaController],
  providers: [AuthService, SignupService, JwtStrategy, GiteaService],
  exports: [SignupService],
})
export class AuthModule {}
