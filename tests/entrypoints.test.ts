/**
 * Every way a service is started must name the file the compiler emits for
 * `src/index.ts`: the package's `main`, its `start` script, the prod image's
 * CMD (run from the directory the service is deployed into) and the dev image's
 * entrypoint (run from the workspace root, which the dev compose mounts).
 *
 * And both images must hand their process to node, so the SIGTERM a stop sends
 * reaches the service, which drains, rather than a shell, which dies at once.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

const root = join(__dirname, '..');
const servicesDir = join(root, 'services');

const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8'));

const services = readdirSync(servicesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(servicesDir, name, 'package.json')))
  .filter((name) => existsSync(join(servicesDir, name, 'src', 'index.ts')));

/**
 * Where tsc writes `src/index.ts`, relative to the service directory. With
 * `composite` and no `rootDir`, the root is the directory of the tsconfig.
 */
const emittedEntry = (service: string): string => {
  const { compilerOptions = {} } = readJson(join(servicesDir, service, 'tsconfig.json'));
  const outDir = posix.normalize(compilerOptions.outDir ?? '.');
  const rootDir = posix.normalize(compilerOptions.rootDir ?? '.');
  return posix.join(outDir, posix.relative(rootDir, 'src/index.ts')).replace(/\.ts$/, '.js');
};

/** The last `WORKDIR` of a Dockerfile's final stage. */
const finalWorkdir = (dockerfile: string): string | undefined =>
  dockerfile.split(/^FROM /m).at(-1)?.match(/^WORKDIR (\S+)$/gm)?.at(-1)?.slice('WORKDIR '.length);

describe('the images\' working directories', () => {
  it('runs the prod image from the directory the service is deployed into', () => {
    const dockerfile = readFileSync(join(root, 'docker', 'prod.node.Dockerfile'), 'utf8');
    const deployed = dockerfile.match(/^RUN pnpm .* deploy --prod (\S+)$/m)?.[1];
    const copied = dockerfile.split(/^FROM /m).at(-1)?.match(/^COPY --from=builder (\S+) \.$/m)?.[1];

    expect(deployed).toBeDefined();
    expect(copied).toBe(deployed);
    expect(finalWorkdir(dockerfile)).toBe('/app');
  });

  it('runs the dev image from where the dev compose mounts the workspace root', () => {
    const dockerfile = readFileSync(join(root, 'docker', 'dev.node.Dockerfile'), 'utf8');
    const compose = readFileSync(join(root, 'docker', 'dev.node.compose.yml'), 'utf8');
    const mounted = compose.match(/^\s*- \.\.:(\S+)$/m)?.[1];

    expect(mounted).toBeDefined();
    expect(finalWorkdir(dockerfile)).toBe(mounted);
  });
});

describe('service entrypoints', () => {
  it('finds the node services', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  describe.each(services)('%s', (service) => {
    const pkg = readJson(join(servicesDir, service, 'package.json'));
    const entry = emittedEntry(service);

    it('declares the emitted entry as main', () => {
      expect(posix.normalize(pkg.main)).toBe(entry);
    });

    it('starts the emitted entry', () => {
      expect(pkg.scripts?.start).toBe(`node ${entry}`);
    });

    it('is started by the prod image at the emitted entry', () => {
      const dockerfile = readFileSync(join(root, 'docker', 'prod.node.Dockerfile'), 'utf8');
      const cmd = dockerfile.match(/^CMD .*exec node [^"]*?(\S+\.js)"\]$/m);
      expect(cmd?.[1]).toBe(entry);
    });

    it('is started by the dev image at the emitted entry', () => {
      const script = readFileSync(join(root, 'docker', 'node', 'entrypoint.sh'), 'utf8');
      const exec = script.match(/^exec node .*"services\/\$\{SERVICE_NAME\}\/(\S+\.js)"$/m);
      expect(exec?.[1]).toBe(entry);
    });
  });
});

describe('the stop signal', () => {
  /**
   * A stand-in for node, first on PATH: it records its pid, says when it is
   * listening, and answers SIGTERM by printing it and exiting cleanly.
   */
  let bin: string;

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'entrypoint-'));
    writeFileSync(join(bin, 'node'), [
      '#!/bin/sh',
      `echo $$ > "${join(bin, 'pid')}"`,
      "trap 'echo SIGTERM; exit 0' TERM",
      'echo ready',
      'while :; do sleep 0.05; done',
      '',
    ].join('\n'));
    chmodSync(join(bin, 'node'), 0o755);
  });

  afterAll(() => {
    try { process.kill(Number(readFileSync(join(bin, 'pid'), 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    rmSync(bin, { recursive: true, force: true });
  });

  /** Starts `command`, sends it SIGTERM once node is up, and resolves with what node printed and how it ended. */
  const stop = (command: string[], env: Record<string, string>): Promise<{ out: string; code: number | null }> =>
    new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(command[0], command.slice(1), {
        cwd: bin,
        env: { PATH: `${bin}:${process.env.PATH}`, ...env },
      });
      let out = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('ready') && !child.killed) child.kill('SIGTERM');
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ out, code }));
    });

  it('reaches node under the prod image\'s CMD', async () => {
    const dockerfile = readFileSync(join(root, 'docker', 'prod.node.Dockerfile'), 'utf8');
    const cmd: string[] = JSON.parse(dockerfile.match(/^CMD (\[.*\])$/m)?.[1] ?? '[]');

    const { out, code } = await stop(cmd, { NODE_MEMORY_MB: '2048' });

    expect(out).toContain('SIGTERM');
    expect(code).toBe(0);
  });

  it('reaches node under the dev image\'s entrypoint', async () => {
    const { out, code } = await stop(['sh', join(root, 'docker', 'node', 'entrypoint.sh')], { SERVICE_NAME: 'stocker' });

    expect(out).toContain('SIGTERM');
    expect(code).toBe(0);
  });
});
