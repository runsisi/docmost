import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import * as postgres from 'postgres';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { normalizePostgresUrl } from '../common/helpers';
import { WsGateway } from './ws.gateway';
import { getSpaceRoomName } from './ws.utils';

@Injectable()
export class PageProtectionBridge
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private connection: postgres.Sql;
  constructor(
    private readonly environment: EnvironmentService,
    private readonly ws: WsGateway,
  ) {}

  async onApplicationBootstrap() {
    this.connection = postgres(
      normalizePostgresUrl(this.environment.getDatabaseURL()),
      { max: 1 },
    );
    await this.connection.listen('page_protection', (spaceId) => {
      this.ws.server.to(getSpaceRoomName(spaceId)).emit('message', {
        operation: 'pageProtectionInvalidated',
        spaceId,
      });
    });
  }

  async onModuleDestroy() {
    await this.connection?.end();
  }
}
