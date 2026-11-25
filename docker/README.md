# Docker images

Two Dockerfiles build every Node.js service of the monorepo, one per `APP_ENV`:

| File | `APP_ENV` | What the image holds |
|---|---|---|
| `prod.node.Dockerfile` | `prod` | The whole workspace, installed and built inside the image |
| `dev.node.Dockerfile` | `dev` | The runtime only; the code comes from the host through a bind mount |

A service's compose file picks one with `APP_ENV` (default `prod`) and builds with the repository root as
the context, so the whole workspace, filtered by [`.dockerignore`](../.dockerignore), is available:

```yaml
build:
  context: ../../..                     # the repository root, from services/<name>/docker/
  dockerfile: docker/${APP_ENV:-prod}.node.Dockerfile
  args:
    SERVICE_NAME: <name>
```

The root `.env.example` sets `APP_ENV=dev`.

## Build arguments

| Argument | Default | Meaning |
|---|---|---|
| `SERVICE_NAME` | none, required | The service's path under `services/`. The prod build fails without it. |
| `NODE_MEMORY_MB` | `2048` | The Node.js heap limit, passed as `--max-old-space-size`. Kept in the image as an environment variable of the same name. |
| `DUCKDB_EXTENSIONS` | empty | Prod only. Space-separated DuckDB extensions installed into the runtime user's extension directory (`~/.duckdb/extensions`), with the DuckDB the service resolves, so a service that loads them needs no network at run time. The build fails when one cannot be installed. |

Both images use `node:22.23-alpine3.24` (the `NODE_VERSION` argument), run under `dumb-init` for signal
handling, carry `curl` for healthchecks, and expose port 3000, the services' health port.

## Prod image

The builder stage copies the workspace, runs `pnpm install --frozen-lockfile` (through corepack, so a
lockfile out of step with a `package.json` fails the build), then `pnpm run build`, which builds every
package and service. It fails when `services/$SERVICE_NAME/dist/src/index.js` was not produced.

The runtime stage copies the whole built workspace to `/app`, so workspace links and relative imports
resolve as they do on the host. It sets the working directory to `/app/services/$SERVICE_NAME`, runs as
the image's `node` user (uid 1000), and starts:

```sh
node --max-old-space-size=$NODE_MEMORY_MB dist/src/index.js
```

## Dev image

The dev image installs nothing of the workspace and builds nothing. It runs as `node` (uid 1000) in
`/live`, where the compose file mounts the repository root, and its entrypoint
([`node/entrypoint.sh`](node/entrypoint.sh)) starts `services/$SERVICE_NAME/dist/src/index.js`. It runs
whatever the host's last `pnpm build` produced: build on the host first, and restart the container to pick
up a new build. pnpm is available through corepack, with its store at `/live/.pnpm-store`; a compose file
may replace the entrypoint's command with its own.

## Data directories

Both images run as uid 1000. A host directory bind-mounted for a service to write must be owned by, or
writable for, uid 1000:

```sh
sudo mkdir -p <dir> && sudo chown 1000:1000 <dir>
```

## .dockerignore

[`.dockerignore`](../.dockerignore) keeps out of the build context:

- version control: `.git` at any depth, `.gitignore`, `.gitattributes`;
- environment files: `.env` and `.env.*` at any depth, except `.env.example`;
- host build output, rebuilt in the image: `node_modules`, `dist`, `coverage`, `*.tsbuildinfo`,
  `.pnpm-store`, `.turbo`, `.nx`, vitest timestamp files;
- Python caches: `.venv`, `__pycache__`;
- retired code: `.deprecated` at any depth;
- editor files, `.prettier*`, `.eslint*`, `.github/`, CI files, `TODO.md`, `LICENSE`;
- the root `docs/` directory and the root `README.md`.

Its patterns match from the context root, so a pattern meant for any depth carries a `**/` prefix.
