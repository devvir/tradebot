/**
 * What `docker compose config` makes of every compose file: where each port is
 * published, which credentials the broker and the cache refuse to start
 * without, where the data directories are mounted from, which project each
 * module and pack is, which hostnames the packs serve, how logs rotate, which
 * Host names catalog-ui is told to serve, which settings the router is given,
 * which DuckDB extensions stocker's image is built with, how much memory each
 * container may take, and how long stocker is given to stop. Skipped where
 * docker compose is not installed.
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
  hostname?: string;
  container_name?: string;
  build?: { dockerfile?: string; args?: Record<string, string> };
  ports?: Port[];
  command?: string[];
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
  volumes?: Array<{ source?: string; target: string }>;
  logging?: { driver?: string; options?: Record<string, string> };
  mem_limit?: string;
  stop_grace_period?: string;
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

/** The stubs' compose files, which run only in development and so are checked on their own. */
const stubFiles = composeFiles('services/_stub', 'docker');

/**
 * Every compose file, the stubs' among them, and every file one extends: the
 * services' own bases (services/<name>/docker/base.yml) and the shared node
 * fragments (docker/*.node.compose.yml).
 */
const definitions = [
  ...files,
  ...stubFiles,
  ...readdirSync(join(root, 'services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('services', entry.name, 'docker', 'base.yml'))
    .filter((file) => existsSync(join(root, file))),
  ...readdirSync(join(root, 'docker')).filter((name) => name.endsWith('.node.compose.yml')).map((name) => join('docker', name)),
];

/** Every *_MEM_LIMIT variable any of them reads. */
const memoryVariables = [...new Set(definitions.flatMap((file) =>
  [...readFileSync(join(root, file), 'utf8').matchAll(/\$\{([A-Z0-9_]+_MEM_LIMIT)\b/g)].map((match) => match[1])))];

const MiB = 2 ** 20;
const GiB = 2 ** 30;

/** Bytes in a size the broker reads: a whole number of bytes, KiB, MiB or GiB. */
const brokerBytes = (size: string | undefined): number => {
  const match = size?.match(/^(\d+)(KiB|MiB|GiB)?$/);
  if (!match) return NaN;
  const unit = { KiB: 2 ** 10, MiB, GiB }[match[2] as 'KiB' | 'MiB' | 'GiB'] ?? 1;

  return Number(match[1]) * unit;
};

/** Seconds in a duration as compose renders it, e.g. `1m15s`. */
const seconds = (duration: string | undefined): number =>
  [...(duration ?? '').matchAll(/(\d+)(h|m|s)/g)]
    .reduce((total, [, value, unit]) => total + Number(value) * { h: 3600, m: 60, s: 1 }[unit as 'h' | 'm' | 's'], 0);

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

    it('limits every service\'s memory', () => {
      const unlimited = Object.entries(services(file, required))
        .filter(([, service]) => !(Number(service.mem_limit) > 0))
        .map(([name]) => name);

      expect(unlimited).toEqual([]);
    });

    it('takes each service\'s memory limit from a variable of its own', () => {
      const own = Object.fromEntries(memoryVariables.map((name, index) => [name, `${index + 64}MiB`]));
      const limits = Object.values(services(file, { ...required, ...own })).map((service) => Number(service.mem_limit));
      const given = memoryVariables.map((_name, index) => (index + 64) * MiB);

      expect(new Set(limits).size).toBe(limits.length);
      for (const limit of limits) expect(given).toContain(limit);
    });

    it('leaves each node service a gigabyte beyond its heap and its engine\'s memory, by default', () => {
      const defaultHeapMb = (dockerfile: string): number =>
        Number(readFileSync(join(root, dockerfile), 'utf8').match(/^ARG NODE_MEMORY_MB=(\d+)$/m)?.[1]);
      const short = Object.entries(services(file, required))
        .filter(([, service]) => /^docker\/\w+\.node\.Dockerfile$/.test(service.build?.dockerfile ?? ''))
        .filter(([, service]) => {
          const heap = Number(service.build?.args?.NODE_MEMORY_MB ?? defaultHeapMb(service.build?.dockerfile ?? '')) * MiB;
          const engine = Number(service.environment?.STOCKER_ENGINE_MEMORY_GB ?? 0) * 1e9;

          return !(Number(service.mem_limit) >= heap + engine + GiB);
        })
        .map(([name]) => name);

      expect(short).toEqual([]);
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

  describe('the infra packs\' services', () => {
    /** `host → image prefix` for each URL the root .env.example gives: amqp at a RabbitMQ image, redis at a Redis one. */
    const urls = Object.fromEntries([...readFileSync(join(root, '.env.example'), 'utf8')
      .matchAll(/^[A-Z_]+_URL=(amqp|redis):\/\/[^@\s]*@([a-z0-9-]+):\d+$/gm)]
      .map((match) => [match[2], match[1] === 'amqp' ? 'rabbitmq:' : 'redis:']));

    it('are reached through the root URLs at `queue` and `cache`', () => {
      expect(urls).toEqual({ queue: 'rabbitmq:', cache: 'redis:' });
    });

    const packs = files.filter((file) => file.startsWith('modules/infra/'));

    it.each(packs)('in %s are each one a root URL reaches, named for its host', (file) => {
      const defined = Object.entries(services(file, required));

      expect(defined.length).toBeGreaterThan(0);
      for (const [name, service] of defined) {
        expect(urls).toHaveProperty(name);
        expect(service.image?.startsWith(urls[name])).toBe(true);
        expect([service.hostname, service.container_name]).toEqual([name, name]);
      }
    });
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

  it('finds the stubs', () => {
    expect(stubFiles).toEqual(['services/_stub/ui/docker/compose.yml']);
    expect(definitions).toEqual(expect.arrayContaining([...stubFiles, 'docker/dev.node.compose.yml', 'services/rabbitmq/docker/base.yml']));
  });

  describe('the stub UI', () => {
    const file = 'services/_stub/ui/docker/compose.yml';
    const ui = (env: Record<string, string | undefined>): Service => services(file, env).ui;

    it('is the only service of its file', () => {
      expect(Object.keys(services(file, {}))).toEqual(['ui']);
    });

    it('limits its memory to 3 GiB unless UI_MEM_LIMIT says otherwise', () => {
      expect(memoryVariables).toContain('UI_MEM_LIMIT');
      expect(Number(ui({}).mem_limit)).toBe(3 * GiB);
      expect(Number(ui({ UI_MEM_LIMIT: '1536MiB' }).mem_limit)).toBe(1536 * MiB);
    });

    it('leaves a gigabyte beyond the dev image\'s heap, by default', () => {
      const dockerfile = ui({}).build?.dockerfile ?? '';
      const heap = Number(readFileSync(join(root, dockerfile), 'utf8').match(/^ARG NODE_MEMORY_MB=(\d+)$/m)?.[1]) * MiB;

      expect(dockerfile).toBe('docker/dev.node.Dockerfile');
      expect(Number(ui({}).mem_limit)).toBeGreaterThanOrEqual(heap + GiB);
    });

    it.each([['unset', undefined], ['prod', 'prod'], ['dev', 'dev']])('mounts the checkout at /live with APP_ENV %s', (_label, value) => {
      expect((ui({ APP_ENV: value }).volumes ?? []).filter((volume) => volume.source === root).map((volume) => volume.target))
        .toEqual(['/live']);
    });

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

  it('gives stocker longer to stop than its drain takes', () => {
    const stocker = services('services/stocker/docker/compose.yml', required).stocker;
    const drain = Number(stocker.environment?.STOCKER_DRAIN_SECONDS
      ?? readFileSync(join(root, 'services/stocker/src/config.ts'), 'utf8').match(/STOCKER_DRAIN_SECONDS, (\d+)\)/)?.[1]);

    expect(drain).toBeGreaterThan(0);
    expect(seconds(stocker.stop_grace_period)).toBeGreaterThan(drain);
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

    /** The variable rabbitmq.conf takes the broker's total memory from. */
    const total = readFileSync(join(root, 'services/rabbitmq/docker/rabbitmq.conf'), 'utf8')
      .match(/^total_memory_available_override_value = \$\(([A-Z0-9_]+)\)$/m)?.[1];

    it.each(packs)('in %s takes its container\'s memory limit as its total memory', (file) => {
      for (const env of [required, { ...required, QUEUE_MEM_LIMIT: '1536MiB' }]) {
        const brokers = Object.values(services(file, env)).filter((service) => service.image?.startsWith('rabbitmq:'));

        for (const broker of brokers) {
          expect(total).toBeDefined();
          expect(brokerBytes(broker.environment?.[total ?? ''])).toBe(Number(broker.mem_limit));
        }
      }
    });

    it.each(['QUEUE_USER', 'QUEUE_PASS'])('refuses to render without %s', (name) => {
      const rendered = render('modules/infra/store/compose.yml', { ...required, [name]: '' });

      expect(rendered.ok ? '' : rendered.error).toContain(`${name} is required`);
    });

    it.each(packs)('in %s runs an exact 4.x release', (file) => {
      const images = Object.values(services(file, required))
        .map((service) => service.image ?? '').filter((image) => image.startsWith('rabbitmq:'));

      for (const image of images) expect(image).toMatch(/^rabbitmq:4\.\d+\.\d+-management-alpine$/);
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
