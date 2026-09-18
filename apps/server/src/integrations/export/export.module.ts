import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
import { StorageModule } from '../storage/storage.module';
import { DocxExportService } from './docx-export.service';
import { DocxExportController } from './docx-export.controller';

@Module({
  imports: [StorageModule],
  providers: [ExportService, DocxExportService],
  controllers: [ExportController, DocxExportController],
})
export class ExportModule {}
