# Docker images

Two Dockerfiles build every Node.js service of the monorepo, one per `APP_ENV`:

| File | `APP_ENV` | What the image holds |
|---|---|---|
| `prod.node.Dockerfile` | `prod` | One service, built in the image, with only its production dependencies |
| `dev.node.Dockerfile` | `dev` | The runtime only; the code comes from the host through a bind mount |

Each has a compose fragment beside it, `prod.node.compose.yml` and `dev.node.compose.yml`, holding what a
service needs to run that image: under `dev`, the repository root mounted at `/live`; under `prod`,
nothing. A service's compose file picks both with `APP_ENV` (default `prod`), and builds with the
repository root as the context, so the whole workspace, filtered by [`.dockerignore`](../.dockerignore),
is available:

```yaml
extends:
  file: ../../../docker/${APP_ENV:-prod}.node.compose.yml
  service: node
build:
  context: ../../..                     # the repository root, from services/<name>/docker/
  dockerfile: docker/${APP_ENV:-prod}.node.Dockerfile
  args:
    SERVICE_NAME: <name>
```

`extends` adds the fragment's mounts to the service's own, so its data mounts are the same under either
value. The root `.env.example` sets `APP_ENV=dev`.

## Build arguments

| Argument | Default | Meaning |
|---|---|---|
| `SERVICE_NAME` | none, required | The service's path under `services/`. The prod build fails without it. |
| `NODE_MEMORY_MB` | `2048` | The Node.js heap limit, passed as `--max-old-space-size`. Kept in the image as an environment variable of the same name. |
| `DUCKDB_EXTENSIONS` | empty | Prod only. Space-separated DuckDB extensions installed into the runtime user's extension directory (`~/.duckdb/extensions`), with the DuckDB the service resolves, so a service that loads them needs no network at run time. The build fails when one cannot be installed. |

Both images use `node:22.23-alpine3.24` (the `NODE_VERSION` argument), run under `dumb-init`, carry `curl`
for healthchecks, and expose port 3000, the services' health port. Each starts node with `exec`, so node
is `dumb-init`'s child and receives the SIGTERM a stop sends.

`NODE_MEMORY_MB` bounds the heap alone: buffers, sockets, worker threads and native modules take memory
beside it.

## Prod image

The builder stage, through corepack's pnpm:

1. copies the root `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` alone and runs `pnpm fetch`,
   which downloads every package the lockfile pins into the store. The layer is reused until one of those
   three files changes, so a source change does not download anything again;
2. copies the workspace and runs `pnpm install --frozen-lockfile --offline` from that store (a lockfile out
   of step with a `package.json` fails the build);
3. builds the service and every workspace package it depends on, and fails when
   `services/$SERVICE_NAME/dist/src/index.js` was not produced;
4. runs `pnpm deploy --prod` for the service, which writes the service's files, its production
   dependencies and a built copy of each workspace package it depends on (`@tradebot/*`, `@devvir/*`)
   into one directory of its own, with its own `node_modules`. Each copy holds what the package would
   publish.

The runtime stage copies that directory to `/app`, its working directory, runs as the image's `node` user
(uid 1000), and starts:

```sh
node --max-old-space-size=$NODE_MEMORY_MB dist/src/index.js
```

## Dev image

The dev image installs nothing of the workspace and builds nothing. It runs as `node` (uid 1000) in
`/live`, where `dev.node.compose.yml` mounts the repository root, and its entrypoint
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

- version control: `.git` and `.gitignore` at any depth, `.gitattributes`. A workspace package's copy
  in the prod image leaves out what an ignore file of the package names, and some name `dist/`;
- environment files: `.env` and `.env.*` at any depth, except `.env.example`;
- host build output, rebuilt in the image: `node_modules`, `dist`, `coverage`, `*.tsbuildinfo`,
  `.pnpm-store`, `.turbo`, vitest timestamp files;
- retired code: `.deprecated` at any depth;
- editor files, `.prettier*`, `.eslint*`, `.github/`, CI files, `TODO.md`, `LICENSE`;
- the root `docs/` directory and the root `README.md`.

Its patterns match from the context root, so a pattern meant for any depth carries a `**/` prefix.
