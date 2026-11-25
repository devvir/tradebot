/**
 * What `docker compose config` makes of every compose file: where each port is
 * published, and which credentials the broker and the cache refuse to start
 * without. Skipped where docker compose is not installed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..');

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

/** `<dir>/*` + `<sub>/compose.yml`, for every entry of `dir` that has one. */
const composeFiles = (dir: string, sub: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.deprecated')
    .map((entry) => join(dir, entry.name, sub, 'compose.yml'))
    .filter((file) => existsSync(join(root, file)));

const files = [
  ...readdirSync(join(root, 'modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((group) => composeFiles(join('modules', group.name), '')),
  ...composeFiles('services', 'docker'),
];

/** What the operator must set for any file to render. */
const required = {
  DATA_ARCHIVES_DIR: '/srv/tradebot/archives',
  CATALOG_DIR:       '/srv/tradebot/catalog',
  DATA_VAULT_DIR:    '/srv/tradebot/vault',
  QUEUE_USER:        'tradebot',
  QUEUE_PASS:        'queue-secret',
  CACHE_PASS:        'cache-secret',
};

interface Port { host_ip?: string; target: number; published?: string }
interface Service {
  image?: string;
  ports?: Port[];
  command?: string[];
  healthcheck?: { test?: string[] };
  volumes?: Array<{ source?: string; target: string }>;
}
type Rendered = { ok: true; services: Record<string, Service> } | { ok: false; error: string };

/** Renders `file` with exactly `env`: no shell variables and no .env file. */
const render = (file: string, env: Record<string, string | undefined>): Rendered => {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', devNull, '-f', file, 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
  );
  if (result.status !== 0) return { ok: false, error: result.stderr };

  return { ok: true, services: JSON.parse(result.stdout).services ?? {} };
};

const services = (file: string, env: Record<string, string | undefined>): Record<string, Service> => {
  const rendered = render(file, env);
  if (!rendered.ok) throw new Error(`${file} does not render: ${rendered.error}`);

  return rendered.services;
};

const ports = (rendered: Record<string, Service>): Array<[string, Port]> =>
  Object.entries(rendered).flatMap(([name, service]) => (service.ports ?? []).map((port): [string, Port] => [name, port]));

/** Every *_BIND variable any compose file reads. */
const bindVariables = [...new Set(files.flatMap((file) =>
  [...readFileSync(join(root, file), 'utf8').matchAll(/\$\{([A-Z0-9_]+_BIND)\b/g)].map((match) => match[1])))];

describe.skipIf(!hasCompose)('compose files', () => {
  it('finds the modules, packs and services', () => {
    expect(files).toEqual(expect.arrayContaining([
      'modules/collect/archives/compose.yml',
      'modules/infra/local/compose.yml',
      'services/catalog-ui/docker/compose.yml',
      'services/redis/docker/compose.yml',
    ]));
  });

  describe.each(files)('%s', (file) => {
    it('publishes every port on 127.0.0.1 by default', () => {
      const exposed = ports(services(file, required)).filter(([, port]) => port.host_ip !== '127.0.0.1');

      expect(exposed).toEqual([]);
    });

    it('publishes a port elsewhere only when its *_BIND variable says so', () => {
      const opened = Object.fromEntries(bindVariables.map((name) => [name, '0.0.0.0']));
      const kept = ports(services(file, { ...required, ...opened })).filter(([, port]) => port.host_ip !== '0.0.0.0');

      expect(kept).toEqual([]);
    });

    it('does not publish the health port', () => {
      const rendered = services(file, required);
      const health = ports(rendered).filter(([name, port]) =>
        port.target === 3000 && (rendered[name].healthcheck?.test ?? []).join(' ').includes('localhost:3000/health'));

      expect(health).toEqual([]);
    });
  });

  it('opens one port without opening the others', () => {
    const rendered = services('modules/collect/archives/compose.yml', { ...required, CATALOG_UI_BIND: '0.0.0.0' });

    expect(rendered['catalog-ui'].ports?.map((port) => port.host_ip)).toEqual(['0.0.0.0']);
    expect(rendered.catalog.ports?.map((port) => port.host_ip)).toEqual(['127.0.0.1']);
  });

  describe.each(['modules/infra/local/compose.yml', 'modules/infra/market/compose.yml'])('the cache in %s', (file) => {
    it.each([['unset', undefined], ['empty', '']])('refuses to render with CACHE_PASS %s', (_label, value) => {
      const rendered = render(file, { ...required, CACHE_PASS: value });

      expect(rendered.ok).toBe(false);
      expect(rendered.ok ? '' : rendered.error).toContain('CACHE_PASS is required');
    });

    it('requires the password, and keeps it out of the healthcheck command', () => {
      const cache = Object.values(services(file, required)).find((service) => service.image?.startsWith('redis:'));

      expect(cache?.command).toEqual(expect.arrayContaining(['--requirepass', required.CACHE_PASS]));
      expect(cache?.healthcheck?.test?.join(' ')).not.toContain(required.CACHE_PASS);
    });
  });

  describe('the broker', () => {
    const packs = files.filter((file) => file.startsWith('modules/infra/'));

    it.each(['QUEUE_USER', 'QUEUE_PASS'])('refuses to render without %s', (name) => {
      const rendered = render('modules/infra/bootcamp/compose.yml', { ...required, [name]: '' });

      expect(rendered.ok ? '' : rendered.error).toContain(`${name} is required`);
    });

    it.each(packs)('in %s adds its config beside the image\'s own, never over conf.d', (file) => {
      const brokers = Object.values(services(file, required)).filter((service) => service.image?.startsWith('rabbitmq:'));

      for (const broker of brokers) {
        const targets = (broker.volumes ?? []).map((volume) => volume.target);

        expect(targets).toContain('/etc/rabbitmq/conf.d/90-tradebot.conf');
        expect(targets).not.toContain('/etc/rabbitmq/conf.d');
      }
    });
  });
});
