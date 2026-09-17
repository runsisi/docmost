import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../../../integrations/environment/environment.validation';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

describe('Gitea configuration boundary', () => {
  const config = {
    DATABASE_URL: 'postgresql://user:password@localhost/docmost',
    REDIS_URL: 'redis://localhost:6379',
    APP_SECRET: 'a'.repeat(64),
    GITEA_ENABLED: 'true',
    GITEA_ISSUER: 'https://gitea.example.com',
    GITEA_CLIENT_ID: 'client',
    GITEA_CLIENT_SECRET: 'secret',
    GITEA_ALLOW_SIGNUP: 'false',
  };
  function errors(overrides: Record<string, unknown>) {
    return validateSync(
      plainToInstance(EnvironmentVariables, { ...config, ...overrides }),
    );
  }

  it('accepts HTTPS and explicitly configured HTTP issuers', () => {
    expect(errors({})).toHaveLength(0);
    expect(errors({ GITEA_ISSUER: 'http://gitea.example.com' })).toHaveLength(
      0,
    );
  });

  it.each(['GITEA_ISSUER', 'GITEA_CLIENT_ID', 'GITEA_CLIENT_SECRET'])(
    'requires %s when enabled',
    (key) => {
      expect(
        errors({ [key]: '' }).some((error) => error.property === key),
      ).toBe(true);
    },
  );

  it.each([
    'ftp://gitea.example.com',
    'https://user:password@gitea.example.com',
    'https://gitea.example.com?x=1',
    'https://gitea.example.com#fragment',
  ])('rejects invalid issuer %s', (issuer) => {
    expect(
      errors({ GITEA_ISSUER: issuer }).some(
        (error) => error.property === 'GITEA_ISSUER',
      ),
    ).toBe(true);
  });

  it('allows empty credentials while disabled', () => {
    expect(
      errors({
        GITEA_ENABLED: 'false',
        GITEA_ISSUER: '',
        GITEA_CLIENT_ID: '',
        GITEA_CLIENT_SECRET: '',
      }),
    ).toHaveLength(0);
  });

  it('defaults to disabled with automatic signup disabled', () => {
    const service = new EnvironmentService(new ConfigService({}));
    expect(service.isGiteaEnabled()).toBe(false);
    expect(service.getGiteaConfig().allowSignup).toBe(false);
  });

  it('does not enable this instance-wide provider in cloud mode', () => {
    const service = new EnvironmentService(
      new ConfigService({ ...config, CLOUD: 'true' }),
    );
    expect(service.isGiteaEnabled()).toBe(false);
  });
});
