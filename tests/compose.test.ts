/**
 * What `docker compose config` makes of every compose file: where each port is
 * published, which credentials the broker and the cache refuse to start
 * without, where the data directories are mounted from, which project each
 * module and pack is, how logs rotate, which Host names catalog-ui is told to
 * serve, which settings the router is given, and which DuckDB
 * extensions stocker's image is built with. Skipped where docker compose is
 * not installed.
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
  DATA_DIR:          '/srv/tradebot',
  QUEUE_USER:        'tradebot',
  QUEUE_PASS:        'queue-secret',
  CACHE_PASS:        'cache-secret',
};

interface Port { host_ip?: string; target: number; published?: string }
interface Service {
  image?: string;
  build?: { dockerfile?: string; args?: Record<string, string> };
  ports?: Port[];
  command?: string[];
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  volumes?: Array<{ source?: string; target: string }>;
  logging?: { driver?: string; options?: Record<string, string> };
}
type Rendered = { ok: true; name: string; services: Record<string, Service> } | { ok: false; error: string };

/** Renders `file` with exactly `env`: no shell variables and no .env file. */
const render = (file: string, env: Record<string, string | undefined>): Rendered => {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', devNull, '-f', file, 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
  );
  if (result.status !== 0) return { ok: false, error: result.stderr };

  const config = JSON.parse(result.stdout);

  return { ok: true, name: config.name, services: config.services ?? {} };
};

const services = (file: string, env: Record<string, string | undefined>): Record<string, Service> => {
  const rendered = render(file, env);
  if (!rendered.ok) throw new Error(`${file} does not render: ${rendered.error}`);

  return rendered.services;
};

const projectName = (file: string): string => {
  const rendered = render(file, required);
  if (!rendered.ok) throw new Error(`${file} does not render: ${rendered.error}`);

  return rendered.name;
};

const ports = (rendered: Record<string, Service>): Array<[string, Port]> =>
  Object.entries(rendered).flatMap(([name, service]) => (service.ports ?? []).map((port): [string, Port] => [name, port]));

/** Every *_BIND variable any compose file reads. */
const bindVariables = [...new Set(files.flatMap((file) =>
  [...readFileSync(join(root, file), 'utf8').matchAll(/\$\{([A-Z0-9_]+_BIND)\b/g)].map((match) => match[1])))];

describe('the infra packs', () => {
  const packs = readdirSync(join(root, 'modules/infra'), { withFileTypes: true }).filter((entry) => entry.isDirectory());

  it.each(packs.map((pack) => pack.name))('%s starts only when named', (pack) => {
    expect(existsSync(join(root, 'modules/infra', pack, '.dxskip'))).toBe(true);
  });
});

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

    it('rotates every service\'s logs', () => {
      const unrotated = Object.entries(services(file, required))
        .filter(([, service]) => service.logging?.driver !== 'local'
          || service.logging.options?.['max-size'] !== '50m'
          || service.logging.options?.['max-file'] !== '5')
        .map(([name]) => name);

      expect(unrotated).toEqual([]);
    });
  });

  describe('the checkout', () => {
    /** `service: target` for every mount of the repository root, or at /live. */
    const checkoutMounts = (env: Record<string, string | undefined>) => (file: string): string[] =>
      Object.entries(services(file, { ...required, ...env }))
        .flatMap(([name, service]) => (service.volumes ?? [])
          .filter((volume) => volume.source === root || volume.target === '/live')
          .map((volume) => `${name}: ${volume.target}`));

    /** Every mount but the checkout's, by service. */
    const otherMounts = (file: string, env: Record<string, string | undefined>): Record<string, Array<[string, string]>> =>
      Object.fromEntries(Object.entries(services(file, { ...required, ...env })).map(([name, service]) => [name,
        (service.volumes ?? []).filter((volume) => volume.target !== '/live').map((volume) => [volume.source ?? '', volume.target])]));

    it.each([['unset', undefined], ['prod', 'prod']])('is mounted nowhere with APP_ENV %s', (_label, value) => {
      expect(files.flatMap(checkoutMounts({ APP_ENV: value }))).toEqual([]);
    });

    it('is mounted at /live into every service the dev node image runs, with APP_ENV dev', () => {
      const dev = files.flatMap((file) => Object.entries(services(file, { ...required, APP_ENV: 'dev' }))
        .filter(([, service]) => service.build?.dockerfile === 'docker/dev.node.Dockerfile')
        .map(([name, service]) => [name, (service.volumes ?? [])
          .filter((volume) => volume.source === root).map((volume) => volume.target)]));

      expect(dev.length).toBeGreaterThan(0);
      expect(dev).toEqual(dev.map(([name]) => [name, ['/live']]));
    });

    it.each(files)('leaves every other mount of %s the same in dev and prod', (file) => {
      expect(otherMounts(file, { APP_ENV: 'dev' })).toEqual(otherMounts(file, { APP_ENV: 'prod' }));
    });
  });

  it('gives every module and pack a project of its own', () => {
    const modules = files.filter((file) => file.startsWith('modules/'));
    const names = modules.map(projectName);

    expect(new Set(names).size).toBe(modules.length);
  });

  it.each(files.filter((file) => file.startsWith('modules/infra/')))('%s serves any cache as `cache`', (file) => {
    const caches = Object.entries(services(file, required))
      .filter(([, service]) => service.image?.startsWith('redis:'))
      .map(([name]) => name);

    expect(caches).toEqual(caches.length ? ['cache'] : []);
  });

  it('opens one port without opening the others', () => {
    const rendered = services('modules/collect/archives/compose.yml', { ...required, CATALOG_UI_BIND: '0.0.0.0' });

    expect(rendered['catalog-ui'].ports?.map((port) => port.host_ip)).toEqual(['0.0.0.0']);
    expect(rendered.catalog.ports?.map((port) => port.host_ip)).toEqual(['127.0.0.1']);
  });

  describe('catalog-ui\'s Host allowlist', () => {
    const hosts = (env: Record<string, string | undefined>): string | undefined =>
      services('modules/collect/archives/compose.yml', env)['catalog-ui'].environment?.CATALOG_UI_HOSTS;

    it('is empty unless set', () => {
      expect(hosts(required)).toBe('');
    });

    it('takes CATALOG_UI_HOSTS as given', () => {
      expect(hosts({ ...required, CATALOG_UI_HOSTS: 'localhost,catalog.lan' })).toBe('localhost,catalog.lan');
    });
  });

  describe('the stub UI', () => {
    const file = 'services/_stub/ui/docker/compose.yml';
    const ui = (env: Record<string, string | undefined>): Service => services(file, env).ui;

    it('publishes its port on 127.0.0.1 unless UI_BIND names another address', () => {
      expect(ui({}).ports?.map((port) => [port.host_ip, port.published])).toEqual([['127.0.0.1', '3000']]);
      expect(ui({ UI_BIND: '0.0.0.0', UI_PORT: '3300' }).ports?.map((port) => [port.host_ip, port.published]))
        .toEqual([['0.0.0.0', '3300']]);
    });
  });

  describe('the router\'s prefetch', () => {
    const prefetch = (env: Record<string, string | undefined>): string | undefined =>
      services('services/router/docker/compose.yml', { QUEUE_URL: 'amqp://queue', ...env }).router.environment?.ROUTER_PREFETCH;

    it('is 500 unless set', () => {
      expect(prefetch({})).toBe('500');
    });

    it('takes ROUTER_PREFETCH as given', () => {
      expect(prefetch({ ROUTER_PREFETCH: '50' })).toBe('50');
    });
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

  it('builds stocker\'s image with every DuckDB extension its formats load', () => {
    const formats = join(root, 'services/stocker/src/formats');
    const loaded = readdirSync(formats)
      .flatMap((file) => [...readFileSync(join(formats, file), 'utf8').matchAll(/^\s*extensions:\s*\[([^\]]*)\]/gm)])
      .flatMap((match) => [...match[1].matchAll(/'([^']+)'/g)].map((name) => name[1]));
    const installed = (services('services/stocker/docker/compose.yml', required).stocker.build?.args?.DUCKDB_EXTENSIONS ?? '')
      .split(/\s+/).filter(Boolean);

    expect(loaded).toContain('excel');
    expect(installed).toEqual(expect.arrayContaining(loaded));
  });

  describe.each([
    ['services/hauler/docker/compose.yml',     'hauler',     { DATA_ARCHIVES_DIR: '/data/archives' }],
    ['services/stocker/docker/compose.yml',    'stocker',    { DATA_ARCHIVES_DIR: '/data/archives', DATA_VAULT_DIR: '/data/vault' }],
    ['services/catalog/docker/compose.yml',    'catalog',    { CATALOG_DIR: '/data/catalog' }],
    ['services/prospector/docker/compose.yml', 'prospector', { CATALOG_DIR: '/data/catalog' }],
  ])('the data mounts of %s', (file, name, mounts: Record<string, string>) => {
    /** Host path → container path of every mount under /data. */
    const mounted = (env: Record<string, string | undefined>): Record<string, string> =>
      Object.fromEntries((services(file, env)[name].volumes ?? [])
        .filter((volume) => volume.target.startsWith('/data/'))
        .map((volume) => [volume.target, volume.source ?? '']));

    it.each([['unset', undefined], ['empty', '']])('refuses to render with DATA_DIR %s', (_label, value) => {
      const rendered = render(file, { ...required, DATA_DIR: value });

      expect(rendered.ok).toBe(false);
      expect(rendered.ok ? '' : rendered.error).toContain('DATA_DIR is not defined');
    });

    it('defaults each under DATA_DIR', () => {
      expect(mounted(required)).toEqual(Object.fromEntries(Object.values(mounts)
        .map((target) => [target, `${required.DATA_DIR}/${target.slice('/data/'.length)}`])));
    });

    it('takes each from its own variable, which needs no DATA_DIR', () => {
      const own = Object.fromEntries(Object.keys(mounts).map((variable) => [variable, `/elsewhere/${variable}`]));

      expect(mounted({ ...required, DATA_DIR: '', ...own })).toEqual(Object.fromEntries(Object.entries(mounts)
        .map(([variable, target]) => [target, `/elsewhere/${variable}`])));
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
