# Infra review: consolidated findings

Scope: docker/**, service docker/ compose files, rabbitmq/redis, modules/**, env examples, ignore files, .github/**, root and per-package configs.

## Overall assessment

Every deploy path in the infra layer is broken in at least one place, and most of the infra documentation describes files, variables, hostnames, modules and behaviour that no longer exist.

Blockers:
- The prod Node image starts dist/index.js. tsc writes dist/src/index.js, so every container built with APP_ENV=prod or with APP_ENV unset (the compose default is prod) crash-loops.
- If you copy the shipped .env.example files as their own instructions say, every `VAR=   # comment` line becomes the literal comment text. That covers the project name, data paths, credentials, venue lists, lenses and token, so prospector and stocker crash-loop.
- The shared external network compose expects (`${PROJECT_NAME:-tradebot}-network`) is never created. dx creates `${COMPOSE_PROJECT_NAME||dx}-network`, and setting COMPOSE_PROJECT_NAME to make the names match merges every module into one compose project.

Security:
- Every published port binds 0.0.0.0. That includes catalog-ui, an unauthenticated proxy that adds CATALOG_TOKEN to every request it forwards to the catalog and to prospector's private API, and it is also reachable by cross-site form posts. It also includes Redis (no auth when CACHE_PASS is empty), the RabbitMQ ports, and every :3000 health port.
- .dockerignore matches only top-level paths, so module .env secrets, nested dist and node_modules, and tsbuildinfo end up in prod images.
- The whole repo, every .env file included, is bind-mounted writable into every container, prod included.

Smaller problems:
- The RabbitMQ conf.d mount hides the image's defaults, including console logging.
- Base images are unpinned, and RabbitMQ 3.12 is EOL.
- infra/store and warehouse are the same compose project, packs reuse container names, and a bare `tb up` starts every pack.
- The market pack's Redis answers as `redis` while CACHE_URL targets `cache`.
- Test files are never type-checked: prospector's tests alone have 168 errors against outdated signatures.
- Root lint, check and format scripts do nothing, and `pnpm test` fails at catalog-ui, which has no tests.
- shared/* tsbuildinfo sits outside dist, so a rebuild emits nothing.
- There is no CI. nx is configured but unused, and .github holds only Nx Cloud boilerplate.
- Dependencies are unused, phantom or drifting, and @types/node 25 is used against a Node 22 runtime.
- Coverage gates fail.
- knip is misconfigured.
- Env parsing, retry logic and the vault ledger format are copied across packages and behave differently.

Three env parsers disagree on the same files. dx strips no comments, dev/tooling strips `\s+#.*` even after an empty value, and compose strips only after a non-empty value. The .env.example fix (comments on their own lines) makes all three agree, and an automated `docker compose config` check over the examples should keep them that way.

Restructuring recommendations, from both lenses:
1. Pick one deploy story. The base service compose gets no /live mount and no host ports, and a dev-only override (added when APP_ENV=dev) adds them. The prod image becomes a `pnpm deploy` of one service. This fixes INF-01, INF-05, INF-11, INF-20 and INF-21 together, but it needs a mechanism, either in dx or in the compose files, to load a per-env override.
2. Give network and project naming one owner. Settle on PROJECT_NAME for the network, never set COMPOSE_PROJECT_NAME, give every module and pack a unique explicit `name:`, and create the network from the in-repo `tb` wrapper until dx derives it itself.
3. Create shared homes for copied logic: an env/config helper, a retry helper, a vault-format module, and the catalog schema next to shared/lenses.
4. Add CI that runs build, per-package typecheck with tests included, tests, knip and the compose-render check. Most of these problems stayed hidden because nothing runs these checks.

Environment notes, not counted as defects: pipe's integration tests need a Docker daemon (global-setup.ts), stocker's xlsx test needs network access, and prospector's 'refuses a catalog it cannot write' fails when the tests run as root. These tests should skip, not fail, when the dependency is missing.

dx is a submodule and out of scope. Several symptoms originate there (parseEnvFile keeps inline comments, ensureNetworkExists passes an unquoted name into a shell string, and there is no per-env override), and those should be raised with dx's owner.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| INF-01 | critical | correctness | IMPLEMENT | Prod Node image CMD runs dist/index.js, but every service compiles to dist/src/index.js, so every prod container crash-loops |
| INF-02 | high | config | IMPLEMENT | Inline comments after empty values in .env.example files become literal values in compose: broken project name, paths, credentials, venue lists, lenses and token |
| INF-03 | high | config | IMPLEMENT | The shared external network name never matches what `tb` creates, and the only workaround (COMPOSE_PROJECT_NAME) merges every module into one compose project |
| INF-04 | high | security | IMPLEMENT | catalog-ui (an unauthenticated proxy that adds CATALOG_TOKEN), the catalog, Redis, RabbitMQ, vault and every :3000 health port are published on all host interfaces |
| INF-05 | medium | security | IMPLEMENT | .dockerignore matches only top-level paths, so module .env secrets, nested dist, node_modules and tsbuildinfo are baked into prod images |
| INF-06 | medium | testing | IMPLEMENT | Test files are never type-checked; prospector's tests alone have 168 errors, many against outdated signatures |
| INF-07 | medium | config | IMPLEMENT | Compose project and container name collisions: infra/store and warehouse are both project "store", local and bootcamp are both "infrastructure", and a bare `tb up` starts every pack |
| INF-08 | medium | config | IMPLEMENT | Infra config contradicts itself: market's Redis answers as `redis` while CACHE_URL targets `cache`; local has no `queue` although docs say it does; stale VAULT_URL and REGISTRY_* entries |
| INF-09 | medium | security | IMPLEMENT | Redis and RabbitMQ credentials are not enforced: an empty CACHE_PASS gives a no-auth Redis, the Redis password sits in the healthcheck argv, QUEUE_* falls back to guest, and passwords are not URL-encoded |
| INF-10 | medium | robustness | IMPLEMENT | Mounting services/rabbitmq/docker over /etc/rabbitmq/conf.d hides the image's 10-defaults.conf, so console logging is lost and the guest policy changes |
| INF-11 | medium | robustness | IMPLEMENT | Prod Node build is not reproducible: unfrozen lockfile, image user is root, the whole workspace is built for each service, and corepack is needed at runtime |
| INF-12 | medium | docs | IMPLEMENT | docker/README.md describes a Dockerfile, npm build and 'minimal image' that do not exist |
| INF-13 | medium | config | IMPLEMENT | Root lint, check and format scripts do nothing and fail, `pnpm dev` starts every service on the host, and `pnpm test` fails at catalog-ui, which has no test files |
| INF-14 | medium | config | IMPLEMENT | shared/* and dev/tooling write tsbuildinfo outside dist, so a rebuild after deleting dist emits nothing |
| INF-15 | medium | config | IMPLEMENT | No CI: nothing runs build, typecheck, tests, knip or the compose checks |
| INF-16 | medium | config | IMPLEMENT | CATALOG_DIR is documented as defaulting under the data root but has no default, so `tb up archives` aborts |
| INF-17 | medium | docs | IMPLEMENT | Compose comments and env examples contradict the services and each other |
| INF-18 | medium | security | IMPLEMENT | Floating base-image tags, and unused Python Dockerfiles that pull uv:latest and run as root |
| INF-19 | medium | security | DEFER | RabbitMQ runs on the EOL 3.12 series while the README claims 3.13 |
| INF-20 | medium | security | DEFER | The whole monorepo, every .env file included, is bind-mounted writable into every container, prod included |
| INF-21 | medium | efficiency | DEFER | Prod image ships the whole monorepo with dev dependencies for every service, and the install layer is invalidated by any edit |
| INF-22 | low | docs | IMPLEMENT | RabbitMQ, Redis and infra-pack READMEs, .github/copilot-instructions.md and .gitignore describe things that do not exist |
| INF-23 | low | code-quality | IMPLEMENT | Dependency hygiene: unused and phantom dependencies, version drift, and @types/node 25 against a Node 22 runtime |
| INF-24 | low | robustness | IMPLEMENT | No log rotation on any container |
| INF-25 | low | config | IMPLEMENT | knip config: wrong path aliases, legacy and .deprecated noise, tests and .tsx excluded, dead shared exports hidden |
| INF-26 | low | testing | IMPLEMENT | Test config hygiene: dead minWorkers, testing helpers exported from the runtime barrel, prospector tests mocking service-kit from its src, console output suppressed |
| INF-27 | low | testing | IMPLEMENT | Coverage thresholds fail and are enforced nowhere; credential-redaction and service-bootstrap helpers in shared/utils have 0% coverage |
| INF-28 | low | config | DEFER | nx and @nx/vitest are installed and configured but unused, and .github holds only Nx Cloud CI skills and agents for a CI the repo does not have |
| INF-29 | low | code-quality | DEFER | Env parsing, retry/backoff and the vault ledger format are copied across packages and behave differently |
| INF-30 | low | architecture | DEFER | shared/lenses runs SQL against tables defined in prospector's migrations, and catalog's tests keep a hand-copied schema |
| INF-31 | low | robustness | DEFER | Two brokers per host each use the 60%-of-host-RAM watermark, and no container has a memory limit |
| INF-32 | low | robustness | DEFER | Stocker downloads the DuckDB excel extension at runtime into the container's ephemeral home |

## INF-01: Prod Node image CMD runs dist/index.js, but every service compiles to dist/src/index.js, so every prod container crash-loops

- **Severity:** critical
- **Category:** correctness
- **Decision:** IMPLEMENT

**Locations:**
- `docker/prod.node.Dockerfile:53`
- `docker/prod.node.Dockerfile:62`
- `docker/node/entrypoint.sh:23`
- `services/{catalog,catalog-ui,hauler,hoarder,pipe,prospector,router,stocker,vault}/package.json:5 (main)`
- `services/*/tsconfig.json`
- `docker/README.md:83`

**Problem:**

Service tsconfigs set outDir ./dist and composite true, with no rootDir, so tsc writes dist/src/index.js. The prod Dockerfile runs `node ... dist/index.js` from WORKDIR /app/services/${SERVICE_NAME}, and that file is never produced. Every service compose file selects docker/${APP_ENV:-prod}.node.Dockerfile, and none overrides `command`. With APP_ENV=prod or unset, every Node service exits with MODULE_NOT_FOUND and `restart: unless-stopped` restarts it forever. The dev entrypoint and every `start` script already use dist/src/index.js. Only `main` and docker/README.md repeat the wrong path. The root .env.example sets APP_ENV=dev, which is why nobody noticed.

**Evidence:**

`ls services/*/dist` shows only src/, tsconfig.tsbuildinfo, and web/ for catalog-ui. Running `node dist/index.js` in services/catalog gives `Cannot find module '/home/user/tradebot/services/catalog/dist/index.js'`. Both lenses and all four verifier passes reproduced it.

**Fix:**

1. Change docker/prod.node.Dockerfile:62 to `CMD ["/bin/sh", "-c", "exec node --max-old-space-size=${NODE_MEMORY_MB} dist/src/index.js"]`. Do not use `pnpm start`: it puts pnpm and corepack between dumb-init and node and drops the memory flag.
2. In the builder, after `RUN pnpm run build`, add `RUN test -f services/${SERVICE_NAME}/dist/src/index.js || (echo "missing dist/src/index.js for ${SERVICE_NAME}" && exit 1)`.
3. Set `main` to `dist/src/index.js` in all nine service package.json files, or drop the field.
4. Fix docker/README.md:83, either as part of INF-12 or before it.
5. Do NOT switch the service tsconfigs to rootDir ./src. catalog-ui's routes.ts:27 resolves join(__dirname,'..','..','web') from dist/src/api, and prospector's build copies seeds into dist/src/database/migrations/seeds.

**Tests to add:**

Add a small vitest test, for example in dev/tooling or at the root, that reads each services/*/package.json and asserts that `main` equals the path in the start script. Where a daemon is available, add a CI smoke step: build one prod image (`docker build -f docker/prod.node.Dockerfile --build-arg SERVICE_NAME=catalog .`) and run `node -e "require.resolve('./dist/src/index.js')"` inside it.

**Verifier notes:**

Unanimous across both lenses and both verifier passes. The first verifier in lens B explained why rootDir must not be used.

## INF-02: Inline comments after empty values in .env.example files become literal values in compose: broken project name, paths, credentials, venue lists, lenses and token

- **Severity:** high
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `.env.example:15`
- `.env.example:23`
- `.env.example:24`
- `.env.example:25`
- `.env.example:33`
- `.env.example:34`
- `.env.example:45`
- `modules/collect/archives/.env.example:42`
- `modules/collect/archives/.env.example:48`
- `modules/collect/archives/.env.example:49`
- `modules/store/warehouse/.env.example:11`
- `modules/store/warehouse/.env.example:14`
- `modules/store/warehouse/.env.example:15`
- `dev/tooling/src/shared/utils/env.ts:28-30`
- `dx/utils/env.js (out of scope)`

**Problem:**

dx runs `docker compose --env-file <root .env> --env-file <module .env>`, so compose's dotenv parser reads these files. Compose strips an inline `# comment` only when it follows a non-empty unquoted value. For `VAR=      # comment`, the value is the comment text itself. That value is non-empty, so `${VAR:-}` defaults never apply. The READMEs tell operators to copy .env.example to .env. Doing that produces these failures:
- An invalid project name.
- DATA_ARCHIVES_DIR set to '# Host data root/archives'.
- QUEUE_USER, QUEUE_PASS and CACHE_PASS set to the publicly known string '# (required)'.
- PROSPECTOR_VENUES and STOCKER_VENUES set to sentences, so prospector and stocker crash-loop on an unknown venue or token.
- HAULER_LENS and STOCKER_LENS set to sentence-long slugs.
- stocker sending the comment text as CATALOG_TOKEN.

The three parsers disagree. dev/tooling's parser strips these comments and its own comment claims this matches compose, which is false. dx's parser strips no comments at all.

**Evidence:**

Reproduced with docker compose v5.7.1 on unmodified copies of the example files:
- `A=   # c` gives '# c'.
- `B="" # c` gives empty, so the default applies.
- `C=x # c` gives 'x'.
- Root example: `invalid project name "# Override project name globally"`.
- Archives: `PROSPECTOR_VENUES: '# Default: <empty> (all). CSV of: ...'`.
- Warehouse: `CATALOG_TOKEN: '# The catalog''s shared secret; empty where it has none'`.
- infra/local: `RABBITMQ_DEFAULT_USER: '# (required)'`.

prospector/src/config.ts:66 and stocker/src/config.ts parseKnown throw on these values.

**Fix:**

1. In all three .env.example files, move every trailing comment on an empty-valued line onto its own `#` line directly above the variable, leaving bare `VAR=`. For consistency, and because dx's parser strips nothing, move the comments on non-empty lines too.
2. Delete the COMPOSE_PROJECT_NAME line (see INF-03).
3. Fix the misleading comment at dev/tooling/src/shared/utils/env.ts:28-30. Preferably make that parser match compose: keep the comment as the value when the value is empty, or reject such lines.
4. Apply this before INF-09, otherwise the `:?` guards never fire.

**Tests to add:**

Add a docker-free vitest test that scans every **/.env.example and fails on any line matching `^[A-Z_]+=\s*#` or `^[A-Z_]+=.*\s#`. Where docker is available, add a CI step that copies each example verbatim, fills only DATA_DIR and CATALOG_DIR with temp dirs, and runs `docker compose -f modules/<m>/compose.yml --env-file <root> --env-file <module> config --format json` for every module and pack. The step fails on a non-zero exit or on any rendered value or volume source that starts with '#'.

**Verifier notes:**

Confirmed high by both verifiers in lens A. Lens B reached the same root cause through its F4, F9 and F10 verifications.

## INF-03: The shared external network name never matches what `tb` creates, and the only workaround (COMPOSE_PROJECT_NAME) merges every module into one compose project

- **Severity:** high
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `modules/collect/archives/compose.yml:30-33`
- `modules/store/warehouse/compose.yml:19-22`
- `modules/infra/local/compose.yml:57-60`
- `modules/infra/store/compose.yml:38-41`
- `modules/infra/market/compose.yml:42-45`
- `modules/infra/shuttle/compose.yml:28-31`
- `modules/infra/bootcamp/compose.yml:26-29`
- `.env.example:14-15`
- `tb`
- `modules/infra/README.md:3`
- `dx/utils/docker.js:60,77 (out of scope)`

**Problem:**

All seven compose files declare `networks.default: {name: ${PROJECT_NAME:-tradebot}-network, external: true}`. The only code in the repo that creates a network is dx's ensureNetworkExists(`${COMPOSE_PROJECT_NAME || 'dx'}-network`).
- With COMPOSE_PROJECT_NAME empty, dx creates dx-network, and every `tb up` fails on the missing external tradebot-network.
- With the example copied verbatim, dx reads the comment text, the `#` comments out the rest of its shell command, and nothing is created. The failure is only logged as a warning.
- Setting COMPOSE_PROJECT_NAME=tradebot makes the names match, but it overrides every file's top-level `name:`. All modules and packs then share one project, each `up` reports the others as orphans, and `--remove-orphans` stops brokers and services.

**Evidence:**

Grep finds no creator of tradebot-network. With COMPOSE_PROJECT_NAME=tradebot, `docker compose config` prints `name: tradebot` for archives, which declares `collect`, and for infra/local, which declares `infrastructure`. dx's parseEnvFile returns COMPOSE_PROJECT_NAME='# Override project name globally'.

**Fix:**

1. Delete the COMPOSE_PROJECT_NAME line from .env.example. Next to PROJECT_NAME, add a comment on its own line saying that PROJECT_NAME only names the shared network `${PROJECT_NAME}-network` and that COMPOSE_PROJECT_NAME must not be set.
2. In the in-repo `tb` wrapper, before `exec node dx.js`, read PROJECT_NAME from the environment or the root .env (default tradebot) and run `docker network inspect "${PROJECT_NAME}-network" >/dev/null 2>&1 || docker network create "${PROJECT_NAME}-network" >/dev/null`. Leave the compose files' network name as it is.
3. Document in modules/infra/README.md that `tb` creates the shared network if it is missing.
4. Raise with dx's owner that dx should derive the network from PROJECT_NAME, strip inline comments in parseEnvFile, quote the name in its shell call, and fail instead of warning.

REJECTED alternative: `${COMPOSE_PROJECT_NAME:-dx}-network` in the compose files. Compose fills that variable with each file's own project name, so every module would get its own network (see Rejected).

**Tests to add:**

Add a script or CI step that runs `docker compose config` in every modules/** directory with the example env. Every module must print the same networks.default.name, and each module must keep its own top-level `name:`. Smoke test on a docker host: on a fresh daemon, `tb up local`, then `tb up archives`, then `docker network ls` shows tradebot-network.

**Verifier notes:**

Confirmed high by all four passes. Lens A's first verifier suggested the network bootstrap in `tb`. Lens B's first verifier suggested `${COMPOSE_PROJECT_NAME:-dx}-network`, and its second verifier refuted that by testing that compose substitutes each project's own name. The consolidated fix follows the bootstrap in `tb`.

**Owner question:** Keep the network name tradebot-network (PROJECT_NAME), as assumed here, or adopt dx's convention? Will you change dx upstream to derive the network from PROJECT_NAME so the `tb` bootstrap can be removed later?

## INF-04: catalog-ui (an unauthenticated proxy that adds CATALOG_TOKEN), the catalog, Redis, RabbitMQ, vault and every :3000 health port are published on all host interfaces

- **Severity:** high
- **Category:** security
- **Decision:** IMPLEMENT

**Locations:**
- `services/catalog-ui/docker/compose.yml:47-52`
- `services/catalog-ui/src/api/routes.ts:30-31`
- `services/catalog-ui/src/api/routes.ts:52-68`
- `services/catalog/docker/compose.yml:41-46`
- `services/{catalog,catalog-ui,hauler,hoarder,prospector,router,stocker}/docker/compose.yml (- :3000)`
- `services/vault/docker/compose.yml:11-13`
- `services/redis/docker/compose.yml:12-13`
- `services/rabbitmq/docker/compose.yml:10-12`
- `modules/infra/local/compose.yml:35-36,45-46`
- `modules/infra/store/compose.yml:17-18`
- `modules/infra/market/compose.yml:21-22`
- `modules/collect/archives/.env.example:22-38`
- `.env.example:30`
- `docs/modules/ARCHIVES.md:53,90`

**Problem:**

No published port sets a host IP, so Docker binds 0.0.0.0 and its iptables rules bypass ufw. An empty host port such as `${X:-}:8080` or `:3000` still publishes, on a random port.

catalog-ui on 9020 is the worst case. forward() passes any method, path and body to the catalog and to prospector's private collector API, adds `x-catalog-token`, and checks nothing about the caller. Anyone who reaches host:9020 can therefore do the following, and CATALOG_TOKEN protects nothing:
- start or pause surveys; a bodyless POST /surveys/pause pauses all venues, and `refresh:true` discards progress
- create, edit or delete lenses on both services
- post download reports

Binding to loopback alone is not enough. service-kit installs only express.json, so a cross-site text/plain or form POST leaves the body unparsed, and forward() then sends `{}` as JSON, with the token, to the upstream. Any page the operator opens can therefore start or pause surveys on a loopback-bound UI.

The archives .env.example implies that an empty CATALOG_PORT keeps the catalog internal. It does not.

**Evidence:**

In the rendered config, every port has mode ingress and no host_ip, and catalog-ui has `published: "9020"`. routes.ts:30-31 mounts forward() for /api/catalog and /api/prospector, and forward() sends method: req.method plus the token header. The CSRF path was traced through service-kit express.ts:278 (json only) and prospector collector.ts:17,31-39 (a missing venue means all venues).

**Fix:**

Do now:
1. Bind every published port to loopback by default, with an opt-in variable, for example `"${CATALOG_UI_BIND:-127.0.0.1}:${CATALOG_UI_PORT:-9020}:8080"` and `"${CATALOG_BIND:-127.0.0.1}:${CATALOG_PORT:-}:8080"`. Apply the same pattern to QUEUE_PORT, QUEUE_MGMT_PORT, QUEUE_RT_PORT, QUEUE_RT_MGMT_PORT, CACHE_PORT and VAULT_PORT, in both the service files and the infra packs that re-declare ports. Document the *_BIND variables in the .env.example files: use 0.0.0.0 only when another host must connect, and in that case also set CATALOG_TOKEN.
2. Remove every `- :3000` host publication. Healthchecks run inside the container, and nothing reads the published port.
3. In catalog-ui forward(), answer 415 to any non-GET/HEAD request whose Content-Type is not application/json. A JSON content type forces a CORS preflight, which the UI never answers. Optionally also reject a request whose Origin differs from its own host.
4. Fix the docs and comments: the CATALOG_PORT and CATALOG_TOKEN comments in the archives .env.example, the catalog-ui compose comment, docs/modules/ARCHIVES.md, and the 'private' wording in catalog-ui config.ts:15-18 and prospector api/collector.ts:8. They should say that whoever reaches catalog-ui acts with the token.

Deferred to the owner: whether catalog-ui needs its own credential before it forwards mutating requests (see owner_question).

**Tests to add:**

Add a catalog-ui vitest test with a stubbed fetch or a stub upstream:
- POST /api/prospector/surveys/pause with text/plain returns 415 and never calls upstream.
- POST with application/json is forwarded with x-catalog-token.
- GET passes status and body through.

This also gives catalog-ui its first test (INF-13). Add a CI or compose-render check that every ports entry has host_ip 127.0.0.1 unless a *_BIND variable overrides it.

**Verifier notes:**

Lens A confirmed high in both passes. Lens B's first verifier rated it high but deferred, because the UI access model is the owner's call. Its second verifier confirmed high and said implement, and supplied the CSRF refinement. The consolidated decision is to implement the bounded parts and defer the UI credential. Corrections: vault is not wired into any module today, and RabbitMQ guest cannot log in remotely because of loopback_users.

**Owner question:** Should catalog-ui get its own credential, such as a CATALOG_UI_PASSWORD checked as basic auth before forwarding, or a CATALOG_UI_WRITE flag that otherwise allows only GET/HEAD? Today it gives token-holder rights to anyone who can reach it. Is remote access over an SSH tunnel acceptable with the loopback default?

## INF-05: .dockerignore matches only top-level paths, so module .env secrets, nested dist, node_modules and tsbuildinfo are baked into prod images

- **Severity:** medium
- **Category:** security
- **Decision:** IMPLEMENT

**Locations:**
- `.dockerignore:7-18`
- `docker/prod.node.Dockerfile:13`
- `docker/prod.node.Dockerfile:50`
- `docker/prod.python.Dockerfile:17`

**Problem:**

Docker matches .dockerignore patterns against the context root, so `.env`, `node_modules/`, `dist/`, `coverage/` and `*.tsbuildinfo` exclude only top-level entries. The build context is the repo root. `COPY . .` followed by `COPY --from=builder /app .` therefore puts the following into the final image:
- modules/*/.env and .env.<APP_ENV>, which hold CATALOG_TOKEN
- dev/tooling/.env, which holds QUEUE_URL credentials
- root .env.dev and .env.prod (only `.env.*.local` is excluded)
- nested node_modules, the host-built dist and tsbuildinfo, .pnpm-store, .nx and services/.deprecated

The build is also not hermetic: leftover dist files from deleted sources ship, and a module .env edit invalidates the install layer.

**Evidence:**

Docker's documented root-relative matching applies, and `**/` is needed to match at depth. `find` shows services/*/dist, services/*/node_modules and shared/*/tsconfig.tsbuildinfo in the tree. dx/utils/docker.js:157-170 loads modules/<m>/.env from the same checkout.

**Fix:**

Rewrite .dockerignore with recursive patterns: `**/.git`, `**/.env`, `**/.env.*`, `!**/.env.example`, `**/node_modules`, `**/dist`, `**/coverage`, `**/*.tsbuildinfo`, `**/.pnpm-store`, `**/.nx`, `**/.venv`, `**/__pycache__`, `**/.deprecated`, `**/tests/.env.testing`. Keep the existing docs and IDE entries. Do NOT exclude `dev/` or `dx`: both are workspace members and lockfile importers, and excluding them changes how `pnpm install` resolves. Use `pnpm install --frozen-lockfile` (INF-11) so that any mismatch between context and lockfile fails loudly. Rebuild existing images. Rotate CATALOG_TOKEN if images ever left the host.

**Tests to add:**

Throwaway check: a busybox Dockerfile that does `COPY . /ctx` and then runs `find /ctx -name '.env*' -o -name '*.tsbuildinfo' -o -name dist -o -name node_modules`, built against the repo root, prints nothing apart from .env.example files. After building a prod image, `docker run --rm --entrypoint sh <img> -c 'find /app -name ".env*" ! -name .env.example'` prints nothing. Add both to CI where a daemon is available.

**Verifier notes:**

The severity split across passes was high, medium, high and medium. It is settled at medium: nothing pushes or exports the images, and the running containers already see the host files through the /live mount (INF-20). It becomes high the moment images are pushed. Lens A's first verifier warned not to exclude dev/ or dx.

## INF-06: Test files are never type-checked; prospector's tests alone have 168 errors, many against outdated signatures

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT

**Locations:**
- `services/*/tsconfig.json (include src/**)`
- `shared/*/tsconfig.json`
- `dev/tooling/tsconfig.json:8`
- `services/prospector/tests/job.test.ts:47,103`
- `services/prospector/tests/bootstrap.test.ts:34`
- `services/catalog/tests/lens.test.ts:125`
- `services/stocker/tests/vault.test.ts:73`

**Problem:**

Every tsconfig includes only src/**, and vitest strips types without checking them. Type-checking tests against their package's src finds these errors:
- prospector 168
- dev/tooling 28
- catalog 8
- hauler 8
- hoarder 8
- vault 7
- stocker 5

Much of this is real drift. For example, 24+ job.test.ts calls pass 3 arguments to surveyVenue, which now takes (db, adapter, config, occasion, paused?). They exercise `occasion === undefined`, a value production never passes. Fake adapters lack getContext/confirm. Config literals miss fields. LensRule literals do not match the type. These tests pass while testing API shapes that no longer exist.

**Evidence:**

Scratch tsconfigs that include tests, under scratch/tsc/*.json, report 168 errors for prospector (104 TS2345, 33 TS2554, 9 TS2741). Example: `tests/job.test.ts(103,27): error TS2554: Expected 4-5 arguments, but got 3.`

**Fix:**

1. In each package, add tsconfig.test.json: `{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true,"composite":false,"incremental":false,"rootDir":"."},"include":["src/**/*","tests/**/*"]}`. Point typeRoots at the root node_modules/@types if `types:["node"]` gives TS2688.
2. Add a `typecheck: tsc -p tsconfig.test.json` script to each package, and have the root run `pnpm -r --if-present typecheck` (see INF-13).
3. Fix the errors, starting with prospector:
   - Pass an explicit occasion to every surveyVenue call.
   - Build one typed fake-adapter factory in tests/setup.ts that includes getContext and confirm.
   - Make the probe and s3 helpers build a real ListingContext or Work.
4. Fix the bootstrap venueId literal and the catalog LensRule literals.

**Tests to add:**

Add one prospector test per Occasion value, asserting the run kind (walk or update) and the occasion passed to getContext. The typecheck script becomes a CI gate (INF-15).

**Verifier notes:**

Lens B's verifier confirmed the 168-error breakdown and downgraded high to medium, because production is not affected. Effort L. The scope touches test code in several units, so coordinate with the per-service reports.

## INF-07: Compose project and container name collisions: infra/store and warehouse are both project "store", local and bootcamp are both "infrastructure", and a bare `tb up` starts every pack

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `modules/infra/store/compose.yml:1-20`
- `modules/store/warehouse/compose.yml:14`
- `modules/infra/local/compose.yml:13`
- `modules/infra/bootcamp/compose.yml:8`
- `modules/infra/market/compose.yml:19`
- `modules/infra/shuttle/compose.yml:18`
- `dx/utils/docker.js:55-71 (out of scope)`

**Problem:**

These name collisions cause the problems below:
- infra/store has no `name:`, so compose names it `store`, which is also the name modules/store/warehouse declares. Each project lists the other's containers as orphans, and `--remove-orphans` on either one removes the brokers or stocker.
- local and bootcamp are both `name: infrastructure`, so `tb down bootcamp` stops the queue-rt that local relies on.
- Every pack hard-codes `container_name: queue` and/or `queue-rt`.
- With no module named, dx loops over every module, including all five packs, because no `.dxskip` file exists. The run aborts with 'container name "/queue-rt" is already in use'.

**Evidence:**

`docker compose config` prints `name: store` for both modules/infra/store and modules/store/warehouse. `find modules -name .dxskip` returns nothing.

**Fix:**

1. Rename the warehouse project to `name: warehouse`. This loses no volumes, because stocker uses bind mounts. On existing hosts, run `docker rm -f stocker` once first.
2. Give every pack an explicit, unique `name:`. Compose prefixes named volumes with the project name, so keep the names that already resolve uniquely to preserve broker data volumes: `store` (once warehouse is renamed), `market` and `shuttle`. Keep `infrastructure` for local and rename bootcamp to `infra-bootcamp`, noting that bootcamp's queue-rt volume resets, or migrate it.
3. Commit an empty `.dxskip` in each modules/infra/<pack>/, so packs start only when named. State this in modules/infra/README.md.
4. COMPOSE_PROJECT_NAME is removed in INF-03.

**Tests to add:**

Run `docker compose config | grep ^name` in every modules/** directory and assert the names are unique. Add this to the compose-render CI check.

**Verifier notes:**

Confirmed by lens A's verifier and lens B's verifier, who also found the local/bootcamp hazard. Lens A's verifier added the volume-prefix caveat, so the generic `infra-*` renames from the original suggestion were adjusted to keep data.

**Owner question:** Is resetting bootcamp's queue-rt volume acceptable, or should the volume be migrated? Alternatively, keep bootcamp as `infrastructure` and rename local.

## INF-08: Infra config contradicts itself: market's Redis answers as `redis` while CACHE_URL targets `cache`; local has no `queue` although docs say it does; stale VAULT_URL and REGISTRY_* entries

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `modules/infra/market/compose.yml:10-11`
- `modules/infra/local/compose.yml:16-26`
- `modules/infra/local/compose.yml:40`
- `.env.example:17-20`
- `.env.example:22-30`
- `.env.example:35-38`
- `.env.example:44-47`
- `modules/infra/README.md:20-24,42,44`
- `services/vault/src/server/index.ts:13`
- `services/vault/README.md:26`

**Problem:**

The infra config disagrees with itself in four places:
- local defines `cache` with `extends`, which matches CACHE_URL=...@cache:6379. market `include`s services/redis/docker/compose.yml, whose service is `redis`, so `cache` does not resolve on a market host. The README table says `redis`.
- local has `queue` commented out, while .env.example and modules/infra/README.md list local as providing it. hoarder, pipe, router and the tooling, which use QUEUE_URL, cannot connect against the local pack. No module wires those services in today, so the breakage is latent.
- `VAULT_URL=http://vault` has no port: vault listens on 8000, and its README says 80. Nothing consumes VAULT_URL.
- REGISTRY_* refers to a service that does not exist. DATA_VAULT_DIR, the Parquet vault, sits next to a 'Vault Service' block for a different CSV dump service.

**Evidence:**

The rendered market config has service `redis` and no `cache` alias. Every line of local compose.yml:16-26 is commented out. Grep finds no consumer of REGISTRY_* or VAULT_URL.

**Fix:**

1. In market/compose.yml, replace the include with `cache:` using `extends: {file: ../../../services/redis/docker/compose.yml, service: redis}`, plus `container_name: cache` and its own `cache-data` volume, as local does. Change the README table and the pack header comments to `cache`.
2. Remove `local` from the queue roles in .env.example:35 and mark queue as absent for local in modules/infra/README.md:44 and in the local header comment. If you prefer, uncomment queue instead (owner decision).
3. Delete the REGISTRY_* block and VAULT_URL. Keep VAULT_PORT and VAULT_COMPRESSION_LEVEL only under a block labelled 'services/vault (raw dump service)', or remove them. Fix services/vault/README.md:26 to say port 8000.
4. Reword DATA_VAULT_DIR as 'the Parquet vault stocker writes'.

**Tests to add:**

Make the compose-render check assert that every pack providing Redis exposes a service or hostname named `cache`.

**Verifier notes:**

Confirmed by both lenses. Several sub-claims are latent rather than current outages, because the services using QUEUE_URL and CACHE_URL are not wired into any module.

**Owner question:** Should the local pack run `queue` again (uncomment it), or is it intentionally queue-rt only?

## INF-09: Redis and RabbitMQ credentials are not enforced: an empty CACHE_PASS gives a no-auth Redis, the Redis password sits in the healthcheck argv, QUEUE_* falls back to guest, and passwords are not URL-encoded

- **Severity:** medium
- **Category:** security
- **Decision:** IMPLEMENT

**Locations:**
- `services/redis/docker/compose.yml:10`
- `services/redis/docker/compose.yml:18`
- `services/redis/docker/compose.yml:21`
- `services/rabbitmq/docker/base.yml:9-10`
- `.env.example:38-47`

**Problem:**

The password handling has four gaps:
- `--requirepass "${CACHE_PASS}"` with an empty value disables auth. The official image also disables protected-mode, and the port is public (INF-04).
- The healthcheck runs `redis-cli -a <pass>` every 30s, so the password is visible in docker inspect and the host's ps.
- RabbitMQ falls back to guest/guest. Through the published ports this fails closed, because guest is loopback-only, but it still lets the stack start with a broker nobody else can log into.
- QUEUE_URL and CACHE_URL interpolate raw passwords, so a password containing @ : / # % ? does not parse.

**Evidence:**

The rendered local pack shows `--requirepass, ""` and healthcheck `[CMD, redis-cli, -a, "", ping]`. base.yml:9 is `${QUEUE_USER:-guest}`.

**Fix:**

1. In redis compose.yml, use `--requirepass "${CACHE_PASS:?CACHE_PASS is required}"` and `CACHE_PASS: ${CACHE_PASS:?CACHE_PASS is required}`.
2. Replace the healthcheck with `test: ["CMD-SHELL", "REDISCLI_AUTH=\"$$CACHE_PASS\" redis-cli ping | grep -q PONG"]`.
3. In rabbitmq base.yml, use `${QUEUE_USER:?QUEUE_USER is required}` and `${QUEUE_PASS:?QUEUE_PASS is required}`.
4. In .env.example, state that QUEUE_PASS and CACHE_PASS must be URL-safe.
5. Apply after INF-02. Check that the market and local packs, which reuse the redis file, still render.

**Tests to add:**

The compose-render check: with CACHE_PASS empty, `docker compose config` on infra/local fails with 'CACHE_PASS is required', and with it set, the rendered healthcheck does not contain the password.

**Verifier notes:**

Lens A's verifier confirmed the Redis part and called the RabbitMQ part overstated, because it fails closed.

## INF-10: Mounting services/rabbitmq/docker over /etc/rabbitmq/conf.d hides the image's 10-defaults.conf, so console logging is lost and the guest policy changes

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT

**Locations:**
- `services/rabbitmq/docker/base.yml:15`
- `services/rabbitmq/docker/rabbitmq.conf:1-18`
- `services/rabbitmq/README.md:26`

**Problem:**

`- .:/etc/rabbitmq/conf.d:ro` replaces the image's conf.d, which ships 10-defaults.conf with `log.console = true` and `loopback_users.guest = false`, and it also mounts the compose files into the broker's config dir. As a result:
- Broker logs go to /var/log/rabbitmq in the container layer, so `docker logs` shows almost nothing.
- guest silently becomes loopback-only, which contradicts the README's 'from any host'.

**Evidence:**

Upstream Dockerfile-alpine.template COPYs 10-defaults.conf into conf.d, and that file contains log.console = true. The rendered config shows the directory bind-mounted at the conf.d target.

**Fix:**

1. In base.yml, replace line 15 with `- ./rabbitmq.conf:/etc/rabbitmq/conf.d/90-tradebot.conf:ro`. Keep the advanced.config mount.
2. Add `log.console = true` to rabbitmq.conf explicitly. Also add `loopback_users.guest = true` so guest stays local-only, which pairs with INF-09's required credentials.
3. Update the README (INF-22).

**Tests to add:**

Manual check: `docker compose -f modules/infra/bootcamp/compose.yml up -d queue-rt`. `docker logs queue-rt` shows the boot banner. `docker exec queue-rt ls /etc/rabbitmq/conf.d` lists only 10-defaults.conf and 90-tradebot.conf.

**Verifier notes:**

Both lenses confirmed this. The metrics-collector sub-claim is refuted: the management variant deletes that file itself.

## INF-11: Prod Node build is not reproducible: unfrozen lockfile, image user is root, the whole workspace is built for each service, and corepack is needed at runtime

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT

**Locations:**
- `docker/prod.node.Dockerfile:19`
- `docker/prod.node.Dockerfile:26`
- `docker/prod.node.Dockerfile:47`
- `docker/prod.node.Dockerfile:50-62`

**Problem:**

The prod build has these problems:
- `RUN pnpm install` runs without --frozen-lockfile and without CI set, so a lockfile that has drifted from package.json is silently re-resolved. This was reproduced in scratch.
- The image has no USER, so it runs as root unless compose overrides it.
- `pnpm run build` builds every workspace package for every image.
- `corepack enable` in the runtime stage is not needed once CMD calls node directly (INF-01).

**Evidence:**

prod.node.Dockerfile:19 `RUN pnpm install` and :26 `RUN pnpm run build`. There is no USER line. Without CI=true, pnpm rewrote the lockfile; with CI=true it refused.

**Fix:**

Quick wins, to land with INF-01 and INF-05:
1. Change :19 to `RUN CI=true pnpm install --frozen-lockfile`.
2. Add `USER node` before CMD.
3. Drop the runtime `corepack enable`.
4. Optionally use `pnpm --filter "@tradebot/${SERVICE_NAME}..." run build`, after checking the package names, because some dependencies are @devvir/* submodules.

The layer-caching and `pnpm deploy` restructure is INF-21.

**Tests to add:**

Build the stocker image. `docker run --rm --entrypoint sh <img> -c 'id -u'` prints 1000. Building with a deliberately stale lockfile fails.

**Verifier notes:**

Merged from lens A F11 and lens B F7. Lens B's verifier deferred the full restructure but endorsed these quick wins, and lens A's verifier said to implement the bounded part.

## INF-12: docker/README.md describes a Dockerfile, npm build and 'minimal image' that do not exist

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT

**Locations:**
- `docker/README.md:7`
- `docker/README.md:32`
- `docker/README.md:46-56`
- `docker/README.md:67`
- `docker/README.md:70-75`
- `docker/README.md:83`

**Problem:**

The README is wrong in several places:
- It documents `docker/node.Dockerfile`. The real files are dev.node, prod.node, dev.python and prod.python, and compose selects `docker/${APP_ENV:-prod}.node.Dockerfile`.
- It describes npm ci and `npm ci --omit=dev`. The build uses pnpm.
- It describes a selective-copy minimal image. The image copies all of /app.
- It says test files are used in the build. tsconfigs exclude them.
- It says .env* is excluded. Only three patterns are.
- It gives the entry point as dist/index.js, which is the bug in INF-01.
- It never mentions the dev image and its /live workflow.

**Evidence:**

`ls docker` shows the four real files. The README says `npm ci` at :49 and 'Entry point at dist/index.js' at :83.

**Fix:**

Rewrite the README around the real files, in present tense only, without naming consuming services, following CLAUDE.md. Cover:
(a) How APP_ENV selects the Dockerfile, with the build context at the repo root.
(b) dev.node: node:22-alpine with dumb-init, user node (uid 1000), and no build step. It runs services/$SERVICE_NAME/dist/src/index.js from the /live mount, which is whatever the host's last `pnpm build` produced. The pnpm store is at /live/.pnpm-store.
(c) prod.node: as it is after INF-01, INF-05 and INF-11.
(d) The SERVICE_NAME and NODE_MEMORY_MB build args. Data dirs must be owned by uid 1000.
(e) What .dockerignore actually excludes.
Remove the Python section if INF-18 deletes those files. Land this together with or after INF-01.

**Tests to add:**

None. Review against the Dockerfiles.

**Verifier notes:**

Merged from lens A F15 and lens B F18. Confirmed in every pass.

## INF-13: Root lint, check and format scripts do nothing and fail, `pnpm dev` starts every service on the host, and `pnpm test` fails at catalog-ui, which has no test files

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `package.json:12-17`
- `services/catalog-ui/package.json:10`
- `.prettierrc`

**Problem:**

No workspace package defines lint, check or format, and neither prettier nor eslint is installed, although .prettierrc exists. `pnpm -r lint` and `pnpm -r check` exit 1. catalog-ui runs `vitest run` with no test files, so it exits 1 and `pnpm -r test` stops there. `pnpm dev` runs every package's ts-node or vite on the host, which collide on port 3000 and never exit.

**Evidence:**

`pnpm -r lint` fails with '"pnpm recursive exec" failed in /home/user/tradebot/dx'. `pnpm --filter @tradebot/catalog-ui test` fails with 'No test files found'.

**Fix:**

1. Remove the root `lint` and `dev` scripts.
2. Add prettier as a root devDependency, with `format: prettier --write .` and `format:check: prettier --check .`.
3. Make `check` run `pnpm -r --if-present typecheck && knip` once INF-06 and INF-25 land.
4. Give catalog-ui a real test (see INF-04), or as a stopgap use `vitest run --passWithNoTests`.
5. Consider `pnpm -r --no-bail test` so one failure does not hide the rest.

**Tests to add:**

The catalog-ui forward() test from INF-04. Root `pnpm test` then exits 0.

**Verifier notes:**

Lens B's verifier confirmed this. Lens A's claim that root `pnpm test` hangs in dx watch mode is refuted: under pnpm -r, vitest gets a non-TTY stdin and runs once.

## INF-14: shared/* and dev/tooling write tsbuildinfo outside dist, so a rebuild after deleting dist emits nothing

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `shared/utils/tsconfig.json:3-7`
- `shared/types/tsconfig.json:3-7`
- `shared/lenses/tsconfig.json:3-7`
- `dev/tooling/tsconfig.json`
- `nx.json:10-17`

**Problem:**

These packages set rootDir ./src, outDir ./dist and composite, so the tsbuildinfo lands at the package root. After `rm -rf dist` or a branch switch, `tsc` sees the old buildinfo, emits nothing and exits 0. Consumers then fail with a confusing 'cannot find module dist/index.js'. Prod Docker builds are unaffected once INF-05 excludes tsbuildinfo.

**Evidence:**

Reproduced on a copy of shared/types with TS 5.9.3: after `rm -rf dist`, both `tsc` and `tsc -b` exit 0 and no dist exists.

**Fix:**

Add `"tsBuildInfoFile": "./dist/tsconfig.tsbuildinfo"` to the four tsconfigs. Delete the stale root-level tsbuildinfo files locally; they are gitignored.

**Tests to add:**

`pnpm --filter @tradebot/types build && rm -rf shared/types/dist && pnpm --filter @tradebot/types build && test -f shared/types/dist/index.js`. This could be a CI step.

**Verifier notes:**

Reproduced by lens B's verifier.

## INF-15: No CI: nothing runs build, typecheck, tests, knip or the compose checks

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `.github/ (no workflows/)`
- `nx.json:3-8`

**Problem:**

There is no .github/workflows, so every check proposed in this report is enforced nowhere. Most of these defects stayed hidden for exactly this reason. Separately, nx.json's test `dependsOn: ['^test']` should be `^build`, because services import shared packages from dist, and the `@nx/vitest:test` default applies to no project.

**Evidence:**

`ls .github/workflows` reports 'No such file'.

**Fix:**

Add .github/workflows/ci.yml: run on push and pull_request, on ubuntu-latest. Use actions/checkout with `submodules: recursive`, setup-node 22 and `corepack enable`. Then run `pnpm install --frozen-lockfile`, `pnpm -r build`, `pnpm -r --if-present typecheck` (INF-06), `pnpm -r test`, the .env.example lint test (INF-02), the compose-render check (INF-02, INF-03, INF-04, INF-07) and `npx knip` after INF-25. Skip environment-dependent tests, such as pipe's docker integration tests and stocker's networked xlsx test, when their dependency is missing. Fix nx.json now as well: `^build`, and drop the @nx/vitest block.

**Tests to add:**

The workflow itself.

**Verifier notes:**

Lens A's verifier left CI to the owner, because this is a single-developer project. Lens B's verifier said implement now. The user's 'fresh start' goal favours implementing. The nx question is split out as INF-28.

## INF-16: CATALOG_DIR is documented as defaulting under the data root but has no default, so `tb up archives` aborts

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `modules/collect/archives/.env.example:9-16`
- `.env.example:23-25`
- `services/prospector/docker/compose.yml:61`
- `services/catalog/docker/compose.yml:39`
- `dev/tooling/src/tools/cold/config.ts:79`
- `dev/tooling/src/shared/utils/env.ts:59-64`
- `shared/utils/src/testing/env.ts:36-37`

**Problem:**

archives/.env.example says CATALOG_DIR 'Defaults under the shared data root' and leaves it empty. Both compose files use `${CATALOG_DIR:?}`, which also rejects empty values, and the root .env.example does not define it. dev/tooling does default it to DATA_DIR/catalog, so tooling and compose disagree. Once the comment from INF-02 is removed, an empty DATA_DIR makes DATA_ARCHIVES_DIR resolve to `/archives`. Docker then creates a root-owned /archives on the host's root filesystem, which uid 1000 cannot write.

**Evidence:**

Rendering with CATALOG_DIR empty fails with 'required variable CATALOG_DIR is missing a value'.

**Fix:**

1. Add `CATALOG_DIR=${DATA_DIR}/catalog` to the root .env.example, next to DATA_ARCHIVES_DIR. Delete the module's empty `CATALOG_DIR=` line, because an empty module value would override the root default. Keep only a comment saying it can be overridden with an absolute host path.
2. Mark DATA_DIR as required in its own-line comment.
3. Do NOT write `${DATA_DIR:?}` into the .env files unless dev/tooling's loadEnv and shared/utils' parseEnvFile learn the `:?` and `:-` modifiers. Today they would look up the key 'DATA_DIR:?...' and silently produce '/archives'.

**Tests to add:**

A dev/tooling loadEnv test on the example files asserts that CATALOG_DIR resolves to <DATA_DIR>/catalog. The compose-render check with only DATA_DIR set succeeds for archives.

**Verifier notes:**

Lens B's verifier corrected the DATA_DIR scenario, which only applies after the comment is removed, and showed that the suggested `:?` form breaks the tooling parsers.

## INF-17: Compose comments and env examples contradict the services and each other

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT

**Locations:**
- `services/hauler/docker/compose.yml:33`
- `services/prospector/docker/compose.yml:48-51`
- `modules/collect/archives/.env.example:9-15`
- `modules/collect/archives/.env.example:42`
- `modules/collect/archives/.env.example:43`
- `modules/collect/archives/README.md:24`
- `services/router/docker/compose.yml:9-13`
- `services/hauler/tests/setup.ts:1-5`

**Problem:**

The comments contradict the code in these places:
(a) hauler's compose says concurrency is 'per venue; venues never wait on each other'. The code, its docs and the env example say it is one budget across every venue.
(b) An orphaned prospector comment describes an HTTP/1.1 connection ceiling that no variable sets.
(c) The PROSPECTOR_CONCURRENCY comment stops mid-sentence ('One transport worker per 1,000').
(d) The venue list in the archives example leaves out bitget.
(e) router reads ROUTER_MAX_READY and ROUTER_WATCH_QUEUES, but its compose does not pass them.
(f) hauler's tests/setup.ts says CATALOG_API and CATALOG_TOKEN have no defaults, but config.ts sets defaults for both.
(g) The archives README presents `tb up archives --build` as 'rebuild'. With APP_ENV=dev it only rebuilds the base image and runs stale host dist. (The CATALOG_DIR comment is covered by INF-16.)

**Evidence:**

hauler src/venue.ts:178-186 uses one module-level budget. prospector config.ts reads only CATALOG_TOKEN, PROSPECTOR_VENUES and PROSPECTOR_CONCURRENCY. router config.ts:13-14 reads both router variables. dev.node.Dockerfile has no build step.

**Fix:**

- hauler compose:33: change to '# Files in flight across every venue together; one budget for the link'.
- Delete the comment at prospector compose:48-51.
- Finish the comment at .env.example:43 after '...the machine's own ceiling', or quote IN_FLIGHT_PER_WORKER accurately.
- List venues as `binance,bitget,bybit,gate,htx,kucoin,okx`, or point to docs/services/PROSPECTOR.md.
- Router compose: add `ROUTER_MAX_READY: ${ROUTER_MAX_READY:-0}` and `ROUTER_WATCH_QUEUES: ${ROUTER_WATCH_QUEUES:-}`, after checking router's defaults.
- Rewrite the hauler setup.ts comment: it pins CATALOG_API to an unroutable host so no test can reach a real catalog.
- Archives README: say that in dev, code changes need `pnpm build` or `tb up archives -i`, and `--build` only rebuilds the image.

**Tests to add:**

None.

**Verifier notes:**

Merged from lens A F18 and lens B F10. Refuted: 'prospector publishes no API port' is accurate, because 3000 is health and not the API. It can optionally be reworded to 'publishes only its health port', which becomes moot once INF-04 removes the :3000 publications.

## INF-18: Floating base-image tags, and unused Python Dockerfiles that pull uv:latest and run as root

- **Severity:** medium
- **Category:** security
- **Decision:** IMPLEMENT

**Locations:**
- `docker/dev.node.Dockerfile:3`
- `docker/prod.node.Dockerfile:3`
- `services/redis/docker/compose.yml:6`
- `docker/dev.python.Dockerfile:14`
- `docker/prod.python.Dockerfile:12,38`
- `docker/python/entrypoint.sh`

**Problem:**

node:22-alpine, redis:7-alpine and ghcr.io/astral-sh/uv:latest are floating tags, so builds drift. No pyproject.toml or *.py exists outside .deprecated, and no compose file references a Python Dockerfile, so those images are dead code. They pull uv:latest, and the dev image runs as root.

**Evidence:**

`find services modules -name pyproject.toml -o -name '*.py'` returns nothing outside .deprecated. `git grep python.Dockerfile` returns nothing.

**Fix:**

1. Pin minor tags, not digests, because no update bot is configured: `ARG NODE_VERSION=22.<minor>-alpine3.<n>` and `redis:7.4-alpine`.
2. Delete docker/dev.python.Dockerfile, docker/prod.python.Dockerfile and docker/python/. If they must stay, pin uv and add USER.
3. The RabbitMQ version is handled in INF-19.

**Tests to add:**

None.

**Verifier notes:**

Lens A's verifier recommended pinning minor tags rather than digests, because there is no Renovate or Dependabot. Lens B's verifier noted that the Python files could be kept if a Python service is imminent.

**Owner question:** Is a Python service coming soon? If so, keep the Python images and pin and harden them instead of deleting them.

## INF-19: RabbitMQ runs on the EOL 3.12 series while the README claims 3.13

- **Severity:** medium
- **Category:** security
- **Decision:** DEFER

**Locations:**
- `services/rabbitmq/docker/base.yml:6`
- `services/rabbitmq/README.md:3`

**Problem:**

RabbitMQ 3.12 no longer gets security fixes, and docker-library has dropped it. Upgrading means enabling all stable feature flags at each step (3.12, then 3.13, then 4.x) on live data volumes, and 4.x removes mirrored classic queues and deprecates transient non-exclusive queues.

**Evidence:**

base.yml:6 is `rabbitmq:3.12-management-alpine`, while README:3 says 3.13. The docker-library 3.12 directory returns 404.

**Fix:**

Owner-planned upgrade. On each host:
1. Run `rabbitmqctl enable_feature_flag all` on 3.12.
2. Move to 3.13-management-alpine and enable all flags again.
3. Audit the packages/rabbitmq queue declarations for durable:false non-exclusive queues.
4. Move to a supported 4.x.
Meanwhile, fix README:3 to state 3.12 (INF-22).

**Tests to add:**

After each step, the broker boots with the existing volume, and the queue-declaring services' integration tests pass.

**Verifier notes:**

Lens A's verifier split this out as an owner decision, because it is a data-volume migration.

**Owner question:** When should the broker upgrade happen, and on which hosts? Do any queues rely on transient non-exclusive or mirrored semantics that 4.x drops?

## INF-20: The whole monorepo, every .env file included, is bind-mounted writable into every container, prod included

- **Severity:** medium
- **Category:** security
- **Decision:** DEFER

**Locations:**
- `services/catalog/docker/compose.yml:38`
- `services/catalog-ui/docker/compose.yml:45`
- `services/hauler/docker/compose.yml:44`
- `services/prospector/docker/compose.yml:60`
- `services/stocker/docker/compose.yml:57`
- `services/vault/docker/base.yml:27`
- `services/hoarder/docker/compose.yml:32`
- `services/pipe/docker/compose.yml:20`
- `services/router/docker/compose.yml:21`
- `docker/dev.node.Dockerfile:30-31`

**Problem:**

Every service mounts `../../../:/live` read-write whatever APP_ENV is. The prod image runs from /app, so in prod the mount only exposes the checkout to every container as uid 1000: the root .env, module .env files, dev/tooling/.env and .git. In dev, a compromised service could rewrite another service's dist. Making the mount dev-only needs a per-env override mechanism, which dx does not have, and dx is a submodule.

**Evidence:**

Every rendered service shows `type: bind, source: /home/user/tradebot, target: /live` with no read_only.

**Fix:**

The owner chooses a mechanism:
(A) dx also passes `docker/compose.${APP_ENV}.yml` when present, and the /live volume and `user` move there.
(B) Compose profiles, or an APP_ENV-selected include.
Do not use an env-substituted mount source with an empty default, because docker creates missing host paths. Mount it :ro unless a service is shown to need writes. Check first whether dev uses /live/.pnpm-store (npm_config_store_dir) and runs in-container pnpm.

**Tests to add:**

With APP_ENV=prod, `docker compose config` shows no /live mount.

**Verifier notes:**

Both lenses confirmed this. Both deferred it, because a structural compose or dx decision is needed. The exploit path is hypothetical, so this is defence in depth.

**Owner question:** How should per-environment compose overrides work: a change to dx, compose profiles, or an include selected by APP_ENV? Does any dev workflow write to /live from inside a container?

## INF-21: Prod image ships the whole monorepo with dev dependencies for every service, and the install layer is invalidated by any edit

- **Severity:** medium
- **Category:** efficiency
- **Decision:** DEFER

**Locations:**
- `docker/prod.node.Dockerfile:13`
- `docker/prod.node.Dockerfile:19`
- `docker/prod.node.Dockerfile:50`

**Problem:**

`COPY . .` comes before install, so any edit invalidates the dependency layer. The final stage copies all of /app: about 600 MB of node_modules including dev dependencies (nx, vite, vitest, typescript), every other service's source, and the submodules. The four archives images are nearly identical multi-hundred-MB images.

**Evidence:**

`du -sh node_modules` reports 607M. Line 50 is `COPY --from=builder /app .`.

**Fix:**

Planned restructure:
1. Copy the lockfile, workspace file and root package.json, run `pnpm fetch --frozen-lockfile` with a BuildKit cache mount, and then `COPY . .`.
2. Run `pnpm install --offline --frozen-lockfile`.
3. Run `pnpm --filter "@tradebot/${SERVICE_NAME}..." build`.
4. Run `pnpm --filter "@tradebot/${SERVICE_NAME}" deploy --prod /out`.
5. The final stage copies only /out, with USER node and `node dist/src/index.js`.

Prerequisites:
- Add `"files": ["dist"]` to shared/* and verify that the submodule packages ship dist, because gitignored dist can be dropped by packlist.
- pnpm 10 deploy needs inject-workspace-packages=true or --legacy.
- Check that prospector's seeds and catalog-ui's dist/web survive.
- Validate against stocker's DuckDB native binding.

**Tests to add:**

Build every archives service, start it, and confirm its healthcheck passes. Compare image sizes before and after.

**Verifier notes:**

Lens B's verifier deferred this, because it needs real image builds and has pnpm-deploy pitfalls. Lens A's verifier also deferred the deploy stage.

**Owner question:** Is a `pnpm deploy`-based slim prod image wanted now? It needs validation on a docker host, and it pairs naturally with INF-20's dev override.

## INF-22: RabbitMQ, Redis and infra-pack READMEs, .github/copilot-instructions.md and .gitignore describe things that do not exist

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT

**Locations:**
- `services/rabbitmq/README.md:3,15-22,26,29,35-42`
- `services/redis/README.md:7-25,37-38,55-60,65-75`
- `modules/infra/README.md:3,20-36,44,62,70,86-88`
- `modules/infra/{local,store,shuttle,market}/compose.yml header comments`
- `.github/copilot-instructions.md:7,9,29,37`
- `.gitignore:7`
- `README.md:55`

**Problem:**

The docs disagree with the compose files throughout:
- The RabbitMQ README says version 3.13; the image is 3.12. It documents RABBITMQ_AMQP_PORT and RABBITMQ_MGMT_PORT, which only the test harness uses; the real variables are QUEUE_PORT and QUEUE_MGMT_PORT, and empty means a random port. It says guest is remote-capable, gives the example host `rabbitmq` and a fake hoarder example, puts credentials in 'your module's .env' when they belong in the root .env, and does not say the default credentials only seed an empty volume.
- The Redis README has a build command for an image with nothing to build, says CACHE_PORT defaults to 6379 (it is random), uses `tb up infra` (no such module) and host `redis`.
- modules/infra/README.md shows the wrong cache host, claims local has queue, mentions DB_*_URL, and names modules that do not exist (archivist, collector, archeologist, packer, gui, concierge, student, witness). The pack header comments repeat these.
- copilot-instructions.md links to docs/ai/README.md, which is missing, via a path that escapes the repo. It prescribes MongoDB and ESLint, and claims services talk only through env vars and queues.
- .gitignore `.github/**/*.md` silently ignores new instruction and skill files.
- The root README calls docs/tooling 'the `tb` tools'.

**Evidence:**

`ls docs/ai` reports nothing. `git ls-files modules` lists only archives, warehouse and the five packs. `git check-ignore -v .github/skills/foo/SKILL.md` matches .gitignore:7.

**Fix:**

Rewrite the docs from the compose files. Each provider doc covers itself on its own terms and does not name consumers (CLAUDE.md).
- RabbitMQ README: the real image tag; that base.yml is meant to be extended; QUEUE_* and QUEUE_RT_* port semantics (loopback after INF-04); that the pack sets the hostname; credentials in the root .env, which seed only an empty volume, rotated with `rabbitmqctl change_password`; guest local-only after INF-10. Drop RABBITMQ_AMQP_PORT or mark it test-harness only.
- Redis README: no build step; CACHE_PORT semantics; a real pack name; the pack sets the hostname (`cache` after INF-08).
- modules/infra/README.md: a per-pack table of the services each compose actually defines and their hostnames; the shared network and its creation by `tb` (INF-03); unique project names and .dxskip (INF-07); log rotation (INF-24). Remove DB_* and the nonexistent modules. Fix the pack header comments to match.
- copilot-instructions.md: reduce it to a pointer to ../CLAUDE.md and ../README.md, or delete it.
- Delete .gitignore:7.
- Confirm with the owner how the cold tools are invoked before editing README.md:55.

**Tests to add:**

None.

**Verifier notes:**

Merged from lens A F16 and F17 and lens B F19. Corrections: a `rabbitmq` host does exist in the standalone services/rabbitmq compose, though no pack uses it, and `redis` is the market pack's host until INF-08 changes it.

**Owner question:** Are the cold tools invoked as `tools cold` or through `tb`? This decides the wording in README.md:55.

## INF-23: Dependency hygiene: unused and phantom dependencies, version drift, and @types/node 25 against a Node 22 runtime

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT

**Locations:**
- `dev/tooling/package.json:15-16,23-24,29-34`
- `package.json:20-26`
- `shared/utils/package.json:11-15`
- `shared/utils/src/tables.ts:1`
- `services/hoarder/package.json`
- `services/_stub/ui/package.json`
- `services/catalog-ui/package.json:35`

**Problem:**

The dependency lists have these problems:
- dev/tooling declares @devvir/zipper, @tradebot/utils, redis, ws and @types/ws, but only .deprecated code uses them.
- The root declares @types/amqplib (duplicated in dev/tooling) and nx (see INF-28).
- Phantom dependencies: shared/utils imports @tradebot/types without declaring it; hoarder uses root @types/ws; the stub UI uses vite and vitest without declaring them; service dev scripts use the root ts-node.
- Version drift: vite 7 and 8 are both in the lockfile; plugin-react 5 and 6; small @types and vitest skews.
- @types/node ^25 against engines ^22.22 and node:22 images lets Node 23-25 APIs type-check and then fail at runtime.

**Evidence:**

knip's unused list matches, confirmed by grep. `ls node_modules/.pnpm | grep ^vite@` shows 7.3.7 and 8.3.3.

**Fix:**

1. Remove the unused dev/tooling dependencies and the root @types/amqplib.
2. Move @types/ws to hoarder's devDependencies.
3. Add `"@tradebot/types": "workspace:*"` to shared/utils and drop it from the root.
4. Add vite and vitest to the stub UI.
5. Pin @types/node to ~22 everywhere and run tsc in every package.
6. Optionally add a pnpm `catalog:` for shared versions.
7. Converge catalog-ui on vite 8 and plugin-react 6 as a separate, tested step.
Do NOT remove react-grid-layout: it is used in WidgetGrid.tsx, and knip only misses it because the glob excludes .tsx (INF-25).

**Tests to add:**

`pnpm install && pnpm -r build && pnpm -r test && npx knip` passes.

**Verifier notes:**

Lens B's verifier refuted react-grid-layout being unused and downgraded the item to low.

## INF-24: No log rotation on any container

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT

**Locations:**
- `services/*/docker/compose.yml`
- `services/vault/docker/base.yml`
- `services/rabbitmq/docker/base.yml`
- `services/redis/docker/compose.yml`

**Problem:**

No service sets `logging:`, so the default json-file driver grows without limit unless daemon.json sets limits. prospector and hauler run for months on archive hosts where disk is the managed resource. This gets worse once INF-10 moves broker logs to the console.

**Evidence:**

`grep -rn logging: services/*/docker modules` finds nothing.

**Fix:**

Add `logging: {driver: local, options: {max-size: "50m", max-file: "5"}}` to every service file, including the rabbitmq base.yml and the redis compose.yml. YAML anchors do not cross include or extends boundaries, so define it per file. Add a sentence to modules/infra/README.md.

**Tests to add:**

The compose-render check asserts a logging block on every service.

**Verifier notes:**

Lens A's verifier confirmed this.

## INF-25: knip config: wrong path aliases, legacy and .deprecated noise, tests and .tsx excluded, dead shared exports hidden

- **Severity:** low
- **Category:** config
- **Decision:** IMPLEMENT

**Locations:**
- `knip.json:1-24`
- `shared/utils/src/stores.ts:4-6`
- `shared/utils/src/security.ts:43`
- `shared/utils/src/testing/compose.ts:23-91`
- `shared/utils/src/testing/env.ts:51`

**Problem:**

knip's report is unusable as configured:
- The services/** paths `../../../shared/*/src` resolve outside the repo.
- .deprecated and legacy code make up about 100 of the 104 'unused files' and all 39 unresolved imports.
- `src/**/*.ts` skips tests and .tsx, which produces false positives such as react-grid-layout.
- Entry re-exports hide dead shared exports: mapGet, redactCredentials and getExposedPort have no consumer, and the _test_* hooks that no test imports go unreported.

**Evidence:**

knip output. `git grep` finds no consumer of mapGet outside its own file.

**Fix:**

1. Add `ignore` entries for **/.deprecated/** and the cold legacy src and tests. Set `ignoreWorkspaces: ["packages/*","dx"]`.
2. Remove the `paths` block; workspace links resolve the packages.
3. Set project to `src/**/*.{ts,tsx}` plus `tests/**/*.ts`.
4. Consider includeEntryExports for shared/**.
5. Delete mapGet, redactCredentials and getExposedPort.
6. Un-export startTestServices and loadEnvFile but keep them, because they are used internally.
7. Decide on POOLED_TABLES and arrayToCsv.
8. Delete the _test_* hooks that no test imports, or add tests for them.

**Tests to add:**

`npx knip` exits clean, which makes it CI-ready (INF-15).

**Verifier notes:**

Merged from lens A F19(1) and lens B F17. Lens B's verifier corrected that startTestServices and loadEnvFile are used internally. The fix drops `paths` instead of correcting it, because services/_stub/ui sits at a different depth.

## INF-26: Test config hygiene: dead minWorkers, testing helpers exported from the runtime barrel, prospector tests mocking service-kit from its src, console output suppressed

- **Severity:** low
- **Category:** testing
- **Decision:** IMPLEMENT

**Locations:**
- `services/catalog/vitest.config.ts:10`
- `services/prospector/vitest.config.ts:20`
- `shared/utils/src/index.ts:10`
- `shared/utils/src/testing/compose.ts:6`
- `services/prospector/tests/setup.ts:11-19`
- `services/pipe/vitest.config.ts:11`
- `services/router/vitest.config.ts:9`

**Problem:**

The test config has four problems:
- vitest 4.1 has no minWorkers option, so it is silently ignored.
- @tradebot/utils re-exports ./testing, so every service loads the child_process and compose helpers at runtime.
- prospector setup imports guardBody from service-kit's src/ rather than from the dist the service actually runs.
- pipe and router set `onConsoleLog: () => false`, which hides console output. Service logs go through pino, so the impact is mostly ad-hoc debugging output.

**Evidence:**

grep finds no minWorkers in the vitest 4.1.11 dist. index.ts:10 is `export * from './testing'`.

**Fix:**

1. Delete both minWorkers lines and keep maxWorkers.
2. Remove `export * from './testing'`. Import `@tradebot/utils/testing` in pipe's tests/setup.ts and global-setup.ts and in router's tests/setup.ts. Make the subpath resolve under node10 resolution: either `exports` plus `typesVersions`, or a testing/package.json stub.
3. In prospector setup.ts, do NOT switch to the package root; that undoes the documented speed-up. Optionally point it at `../../packages/service-kit/dist/net/clients/fetch`.
4. Optionally change onConsoleLog to `(_l, type) => type === 'stderr'`.
5. Optionally type-check the vitest.config.ts files through a noEmit tsconfig.

**Tests to add:**

`tsc --noEmit` passes, and the pipe and router test runs pass with the new import path.

**Verifier notes:**

Merged from lens A F19(2) and lens B F22. Lens B's verifier refuted the suggested prospector fix and showed that the `exports`-only subpath does not work under node10 resolution.

## INF-27: Coverage thresholds fail and are enforced nowhere; credential-redaction and service-bootstrap helpers in shared/utils have 0% coverage

- **Severity:** low
- **Category:** testing
- **Decision:** IMPLEMENT

**Locations:**
- `vitest.config.ts:16-21`
- `shared/utils/src/services.ts:34-94`
- `shared/utils/src/security.ts:6-45`
- `shared/utils/src/csv.ts:21-71`
- `services/hoarder/package.json:13`
- `dev/tooling/vitest.config.ts:1-12`

**Problem:**

The base config sets 60% thresholds, but nothing runs coverage:
- shared/utils is at 42% lines and 24% functions.
- hoarder's branch coverage is 58%, so `test:coverage` always exits 1.
- SKFactory, which 8 services use, has no tests.
- redactUrl and sanitizeUrl, which keep credentials out of logs, have no tests.
- The CSV helpers are only covered indirectly, through vault.
- dev/tooling does not extend the base config at all.

**Evidence:**

`vitest run --coverage` in shared/utils fails all thresholds. The same run in hoarder fails the branch threshold.

**Fix:**

1. Add shared/utils/tests/security.test.ts: redactUrl masks u:p, leaves URLs without credentials unchanged, returns '*****' for invalid input; sanitizeUrl round-trips.
2. Add csv.test.ts: quoting, null cells, a round trip through createCsvParser.
3. Add services.test.ts with SK mocked: rabbitmq and redis provider wiring, topology passthrough, health port 3000 by default, the trackMessages 200/503 logic using fake timers.
4. Make dev/tooling's config `mergeConfig(baseConfig, ...)`.

**Tests to add:**

As listed in the fix.

**Verifier notes:**

Lens B's verifier reproduced the numbers and corrected the usage count to 8 services, not nine.

**Owner question:** Should coverage be enforced in CI, or should per-package thresholds be lowered to their measured values? Either way, do not keep a `test:coverage` script that always fails.

## INF-28: nx and @nx/vitest are installed and configured but unused, and .github holds only Nx Cloud CI skills and agents for a CI the repo does not have

- **Severity:** low
- **Category:** config
- **Decision:** DEFER

**Locations:**
- `package.json:19,26`
- `nx.json:1-25`
- `pnpm-workspace.yaml:20`
- `.github/skills/monitor-ci/`
- `.github/agents/ci-monitor-subagent.agent.md`
- `.github/prompts/`
- `.gitignore (.nx entries)`

**Problem:**

Every script uses `pnpm -r`, and nothing invokes nx, which adds about 40-100 MB to node_modules and to prod images. The .github skills, prompts and agents are Nx-generated 'self-healing CI' guidance that misleads agents.

**Evidence:**

`git grep -nE '\bnx\b|@nx/'` outside .github finds only config entries. knip reports nx as unused.

**Fix:**

If nx is dropped: remove nx, @nx/vitest, nx.json, the allowBuilds `nx: true` entry, the .nx gitignore entries, and the Nx files under .github/skills, agents and prompts, all together. If nx is kept: route the scripts through `nx run-many` and fix targetDefaults (INF-15 already fixes `^build`).

**Tests to add:**

`pnpm install` and `pnpm -r build` still work.

**Verifier notes:**

Lens B's verifier left the removal-versus-adoption choice to the owner. Removing the stale docs fits the user's doc-cleanup goal.

**Owner question:** Remove nx and all its Nx Cloud boilerplate, or adopt it as the task runner?

## INF-29: Env parsing, retry/backoff and the vault ledger format are copied across packages and behave differently

- **Severity:** low
- **Category:** code-quality
- **Decision:** DEFER

**Locations:**
- `services/stocker/src/config.ts:70-78`
- `services/hauler/src/config.ts:33-42`
- `services/prospector/src/config.ts:72-81`
- `services/hauler/src/fetch.ts:323-354`
- `services/prospector/src/http.ts:313-337`
- `shared/utils/src/testing/env.ts:13-46`
- `dev/tooling/src/shared/utils/env.ts:9-64`
- `services/stocker/src/ledger.ts:292-302`
- `dev/tooling/src/tools/cold/shared/vault/ledger.ts:102-113`
- `dx/utils/env.js (out of scope)`

**Problem:**

The copies disagree:
- stocker's parsePositiveInt uses parseInt, so '4.5' becomes 4 and '20GB' becomes 20. hauler and prospector use Number and throw.
- delayFor, the Retry-After parser and sleep are duplicated in hauler and prospector, with only trivial differences.
- There are three .env parsers with different comment and interpolation rules, and none handles `:-` or `:?`.
- The vault ledger file names and sentinels are redeclared separately by stocker, which writes them, and dev/tooling, which reads them, with nothing keeping the two in sync.

**Evidence:**

stocker config.ts:73 `parseInt(raw, 10)` against hauler config.ts:36 `Number(raw)`. The same LEDGER, BACKEDUP, UPDATING and OUTDATED constants are declared in both ledger.ts files.

**Fix:**

Quick win, belonging to the stocker unit: use Number in stocker's parsePositiveInt, with tests that '4.5' and '20GB' throw.

Deferred:
(a) shared/utils env helpers: positiveInt, list, oneOf, and one compose-compatible parseEnvFile.
(b) Shared retry helpers, or service-kit's Backoff.
(c) One vault-format module that stocker and dev/tooling both import, with a writer-to-reader round-trip test.

**Tests to add:**

A writer-to-reader round-trip test for the ledger, and a shared .env fixture test (with INF-02 and INF-16).

**Verifier notes:**

Lens B's verifier corrected two points: dev/tooling's loadEnv does interpolate, and the Retry-After trimming difference does not matter.

**Owner question:** Where should the shared env, retry and vault-format code live (shared/utils or a new shared/vault package)? Should dev/tooling depend on it?

## INF-30: shared/lenses runs SQL against tables defined in prospector's migrations, and catalog's tests keep a hand-copied schema

- **Severity:** low
- **Category:** architecture
- **Decision:** DEFER

**Locations:**
- `shared/lenses/src/members.ts:43-210`
- `shared/lenses/src/draft.ts:100-242`
- `shared/lenses/src/rules.ts:133`
- `shared/lenses/src/store.ts:23-115`
- `services/prospector/src/database/schema.ts:259+`
- `services/catalog/tests/fixture.ts`
- `shared/lenses/package.json`

**Problem:**

The shared package depends on a consumer's internal schema, which inverts the dependency direction. A prospector migration can break catalog without any type error. catalog's tests/fixture.ts keeps a hand-copied SCHEMA that can drift. shared/lenses' own coverage is 14%. The behaviour is exercised by about 48 tests in catalog and prospector, but none of those count toward shared/lenses.

**Evidence:**

shared/lenses' coverage run reports 13.45% lines, with rules.ts and store.ts at 0. The tables are defined only in prospector's schema.ts.

**Fix:**

Owner decision. Option A: move the catalog.db DDL for venue, slice, pattern, series, partition, lens and lens_member into shared/lenses, or a new shared/catalog-schema, as an exported createCatalogSchema(db). prospector's migrations would compose it, and catalog's fixture would import it. Then add in-package tests on `new DatabaseSync(':memory:')` covering:
- rulesFor
- letThrough
- catchUp batching and rebuild
- admit
- putLens and editLens rebuilding
- dropLens cascade
- lensNameIsSound boundaries
- problemsWith

**Tests to add:**

As listed in the fix.

**Verifier notes:**

Lens B's verifier downgraded this to low and deferred it. It also noted that the logic is tested by consumers, so the claim that it is 'untested' is overstated.

**Owner question:** Which package owns the catalog.db schema: prospector, or shared/lenses (or a new schema package)?

## INF-31: Two brokers per host each use the 60%-of-host-RAM watermark, and no container has a memory limit

- **Severity:** low
- **Category:** robustness
- **Decision:** DEFER

**Locations:**
- `services/rabbitmq/docker/rabbitmq.conf:9-10`
- `modules/infra/{local,store,market}/compose.yml`
- `services/stocker/docker/compose.yml:24,48`

**Problem:**

The relative watermark is computed against host RAM when no cgroup limit is set, so two brokers on one host can grow to 120% of RAM. This is not plausible today, because nothing on the store host uses a broker. The suggested stocker sizing was also wrong: DuckDB memory is shared across connections, not multiplied by concurrency.

**Evidence:**

rabbitmq.conf:9 is `vm_memory_high_watermark.relative = 0.6`. No compose file sets mem_limit.

**Fix:**

Once the brokers carry real traffic: `mem_limit: ${QUEUE_MEM_LIMIT:-2g}` and `${QUEUE_RT_MEM_LIMIT:-2g}`. If stocker gets a limit, size it as NODE_MEMORY_MB + STOCKER_ENGINE_MEMORY_GB + 1-2 GB. Check the 3.12 and 3.13 docs before removing paging_ratio.

**Tests to add:**

None.

**Verifier notes:**

Lens A's verifier downgraded this from medium to low and deferred it.

**Owner question:** What memory budget should each host give the brokers and stocker?

## INF-32: Stocker downloads the DuckDB excel extension at runtime into the container's ephemeral home

- **Severity:** low
- **Category:** robustness
- **Decision:** DEFER

**Locations:**
- `services/stocker/src/build.ts:105-108`
- `services/stocker/src/formats/xlsx.ts:12`
- `services/stocker/docker/compose.yml:54-59`

**Problem:**

`INSTALL excel` downloads from extensions.duckdb.org into /home/node/.duckdb, which sits in the container layer. Every recreated container downloads it again, and hosts with restricted egress fail every xlsx partition.

**Evidence:**

build.ts:107 runs `INSTALL ${extension}`. Nothing sets extension_directory.

**Fix:**

Simplest: `SET extension_directory = '<vault dir>/.duckdb-extensions'` before INSTALL, so the extension persists. Alternatively pre-install it into the prod image for offline hosts.

**Tests to add:**

A stocker unit test asserting that extension_directory is set before any INSTALL.

**Verifier notes:**

Lens A's verifier deferred this as a small deployment design choice, and it belongs to the stocker unit.

**Owner question:** Must store hosts work with restricted egress? If so, pre-install the extension in the image. Otherwise persisting it under the vault dir is enough.

## Deferred: decisions needed

- **INF-19** (RabbitMQ runs on the EOL 3.12 series while the README claims 3.13): When should the broker upgrade happen, and on which hosts? Do any queues rely on transient non-exclusive or mirrored semantics that 4.x drops?
- **INF-20** (The whole monorepo, every .env file included, is bind-mounted writable into every container, prod included): How should per-environment compose overrides work: a change to dx, compose profiles, or an include selected by APP_ENV? Does any dev workflow write to /live from inside a container?
- **INF-21** (Prod image ships the whole monorepo with dev dependencies for every service, and the install layer is invalidated by any edit): Is a `pnpm deploy`-based slim prod image wanted now? It needs validation on a docker host, and it pairs naturally with INF-20's dev override.
- **INF-28** (nx and @nx/vitest are installed and configured but unused, and .github holds only Nx Cloud CI skills and agents for a CI the repo does not have): Remove nx and all its Nx Cloud boilerplate, or adopt it as the task runner?
- **INF-29** (Env parsing, retry/backoff and the vault ledger format are copied across packages and behave differently): Where should the shared env, retry and vault-format code live (shared/utils or a new shared/vault package)? Should dev/tooling depend on it?
- **INF-30** (shared/lenses runs SQL against tables defined in prospector's migrations, and catalog's tests keep a hand-copied schema): Which package owns the catalog.db schema: prospector, or shared/lenses (or a new schema package)?
- **INF-31** (Two brokers per host each use the 60%-of-host-RAM watermark, and no container has a memory limit): What memory budget should each host give the brokers and stocker?
- **INF-32** (Stocker downloads the DuckDB excel extension at runtime into the container's ephemeral home): Must store hosts work with restricted egress? If so, pre-install the extension in the image. Otherwise persisting it under the vault dir is enough.

Open questions on implemented items:

- **INF-03**: Keep the network name tradebot-network (PROJECT_NAME), as assumed here, or adopt dx's convention? Will you change dx upstream to derive the network from PROJECT_NAME so the `tb` bootstrap can be removed later?
- **INF-04**: Should catalog-ui get its own credential, such as a CATALOG_UI_PASSWORD checked as basic auth before forwarding, or a CATALOG_UI_WRITE flag that otherwise allows only GET/HEAD? Today it gives token-holder rights to anyone who can reach it. Is remote access over an SSH tunnel acceptable with the loopback default?
- **INF-07**: Is resetting bootcamp's queue-rt volume acceptable, or should the volume be migrated? Alternatively, keep bootcamp as `infrastructure` and rename local.
- **INF-08**: Should the local pack run `queue` again (uncomment it), or is it intentionally queue-rt only?
- **INF-18**: Is a Python service coming soon? If so, keep the Python images and pin and harden them instead of deleting them.
- **INF-22**: Are the cold tools invoked as `tools cold` or through `tb`? This decides the wording in README.md:55.
- **INF-27**: Should coverage be enforced in CI, or should per-package thresholds be lowered to their measured values? Either way, do not keep a `test:coverage` script that always fails.

## Rejected

- **Root `pnpm test` hangs in dx's vitest watch mode (lens A F19 3b)**: Refuted. Under `pnpm -r`, children get a non-TTY stdin, and vitest runs once and exits 0. This was reproduced under a pty.
- **react-grid-layout is an unused dependency (lens B F13 part)**: Refuted. It is imported in services/_stub/ui/src/components/WidgetGrid.tsx. knip misses it because its glob excludes .tsx.
- **Hiding conf.d loses the management image's metrics-collector setting (lens A F8 and lens B F20 part)**: Refuted. The management Dockerfile deletes that file itself.
- **'prospector publishes no API port' is wrong (lens A F18 item 5)**: Refuted. Only the health port is published, not the API. It becomes moot once INF-04 removes the :3000 publications.
- **Fix the network by using `${COMPOSE_PROJECT_NAME:-dx}-network` in the compose files (lens B F4 suggested fix)**: Refuted by the second verifier. Compose fills COMPOSE_PROJECT_NAME with each file's own project name, so each module would get a separate network. See INF-03.
- **Use `${DATA_DIR:?}` inside .env files (lens B F9 suggested fix)**: Rejected as written. The dev/tooling and shared/utils parsers would misread it and silently produce '/archives'. See INF-16.
- **Switch prospector's test setup to import guardBody from the @devvir/service-kit root (lens B F22 suggested fix)**: Rejected. It undoes a documented speed-up, because the root import loads express and ws into every worker. See INF-26.
- **Fix the dist path by adding rootDir ./src to the service tsconfigs (alternative in INF-01)**: Rejected. It breaks catalog-ui's web path resolution and prospector's seed copy location.
- **RabbitMQ guest/guest fallback is remotely exploitable (lens A F4 and F7 part)**: Overstated. guest is loopback-only, so the fallback fails closed. It is kept only as a robustness point in INF-09.
