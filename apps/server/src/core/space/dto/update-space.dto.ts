import { PartialType } from '@nestjs/mapped-types';
import { CreateSpaceDto } from './create-space.dto';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class UpdateSpaceDto extends PartialType(CreateSpaceDto) {
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  spaceId: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  rootDefaultLocked?: boolean;

  @IsOptional()
  @IsBoolean()
  disablePublicSharing: boolean;

  @IsOptional()
  @IsBoolean()
  allowViewerComments: boolean;
}
