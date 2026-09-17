import { Global, Module } from '@nestjs/common';
import { PageProtectionService } from '../protection/page-protection.service';
import { PageAccessService } from './page-access.service';

@Global()
@Module({
  providers: [PageAccessService, PageProtectionService],
  exports: [PageAccessService, PageProtectionService],
})
export class PageAccessModule {}
