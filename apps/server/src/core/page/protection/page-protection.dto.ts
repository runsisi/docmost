import { IsIn, IsUUID, Matches } from 'class-validator';
import { ProtectionMode } from './page-protection.service';

export class PageProtectionDto {
  @IsUUID()
  pageId: string;

  @IsIn(['inherit', 'locked', 'unlocked'])
  mode: ProtectionMode;

  @Matches(/^[a-f0-9]{32}$/)
  version: string;
}
