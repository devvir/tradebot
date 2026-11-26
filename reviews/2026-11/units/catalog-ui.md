# catalog-ui: consolidated review

## Assessment

catalog-ui is a small Express proxy (src/, ~190 lines) plus a React/Mantine page (web/, ~3,700 lines). The front end is XSS-safe: there is no innerHTML or dangerouslySetInnerHTML, values render as React text, and every href comes from linkTo() with encodeURIComponent. The serious problems are in the proxy and the deployment. The proxy forwards every method and path to the catalog and to prospector's private API, with x-catalog-token attached. catalog-ui has no auth and no route allowlist, and compose publishes port 9020 on all interfaces, so CATALOG_TOKEN protects nothing from anyone who can reach that port. That exposes prospector's unvalidated /lenses writes, its /reports (markDownloaded leaves gaps in the archive) and the catalog's /listings/report. The proxy also rewrites every body to application/json, so a cross-site text/plain POST becomes an authenticated `{}` write that starts or pauses every survey (reproduced twice). The proxy does not pass client aborts upstream, which defeats the catalog's stillWanted middleware (catalog/src/api/index.ts:43-59). It relabels content types and drops headers. The default prod image cannot start, because prod.node.Dockerfile runs dist/index.js and every service builds to dist/src/index.js. The package has no tests, and `vitest run` exits 1 because vite.config sets root:'web', which turns the recursive workspace test run red. knip never looks at web/. On the page: lens failures are swallowed (spinners never stop, pickers show 'Nothing found'); lens edits can be lost to concurrent writers; the new-lens dialog accepts addresses the catalog refuses; survey order tracking compares server time with the browser clock; polling restarts and repeats requests; version-skew fallbacks are dead code. The documentation is the weakest part. CATALOG-UI.md and the README describe features that do not exist (instrument search, Both/Per instrument/Buckets), validations nobody performs ('include nothing', 'empty list', 'refused where it claims more than a venue publishes'), and guarantees the code breaks (no state, no derived figures, aborts reach the catalog, prospector is private). Docs and docblocks are full of history ('used to', 'previous version'). They credit prospector's /status to the catalog, explain prospector and venue internals in a consumer doc, and contradict each other on what leaves a row stalled. Recommended order for the fresh start: (1) fix the proxy in routes.ts with tests (allowlist, JSON-only writes with an Origin check, abort/timeout, honest content type), together with the vitest config; (2) fix the prod Dockerfile CMD repo-wide; (3) remove the dead compatibility shims and the history comments, and fix the misplaced docblocks; (4) rewrite CATALOG-UI.md from the code, with the proxy contract kept only there and the README pointing to it; (5) later, as its own change, split Lenses.tsx (1,260 lines) and Surveys.tsx (843 lines) into pure, exported modules (storage, definition helpers, order state machine) with unit tests. Cross-unit observations to pass to the owners of other units: (a) docs/modules/CATALOG-LENSES.md says the catalog writes the lens table and prospector never reads it, while catalog/src/api/lenses.ts:19 and prospector/src/api/lenses.ts say prospector stores lenses, so one side is stale. (b) prospector/src/api/collector.ts:8 and PROSPECTOR.md:~1951 name catalog-ui as their consumer, which breaks the CLAUDE.md dependency direction. (c) docs/modules/ARCHIVES.md:61-62 implies CATALOG_TOKEN protects an exposed deployment, and ARCHIVES.md:85-96 documents the catalog-ui proxy as the shell route to prospector, so restrict the proxy with an allowlist rather than removing it. (d) docker/README.md is stale (it names node.Dockerfile, npm ci and a dist/index.js entry point). (e) shared/lenses/src/types.ts:132 says yyyymmdd while draft.ts and the UI use yyyymm. (f) prospector statusOf calls lastRun twice per venue on every /status poll.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| CUI-01 | critical | security | IMPLEMENT | Proxy is an open relay: every method and path is forwarded to the catalog and prospector's private API with the token attached |
| CUI-02 | high | security | IMPLEMENT | Cross-site simple POSTs become authenticated JSON writes (CSRF): any page an operator visits can start or pause every survey |
| CUI-03 | high | config | IMPLEMENT | Default prod image cannot start: prod.node.Dockerfile runs dist/index.js, but every service builds to dist/src/index.js |
| CUI-04 | medium | robustness | IMPLEMENT | Proxy ignores client aborts and has no upstream timeout: abandoned requests still queue on the single-threaded catalog |
| CUI-05 | medium | testing | IMPLEMENT | No tests at all, and `vitest run` exits 1 because vite.config's root:'web' limits discovery |
| CUI-06 | medium | docs | IMPLEMENT | CATALOG-UI.md and README contradict the code: nonexistent features, validations nobody performs, broken guarantees |
| CUI-07 | medium | docs | IMPLEMENT | Docs and docblocks break CLAUDE.md: history narration, prospector/venue internals in a consumer doc, wrong service attribution, misplaced docblocks |
| CUI-08 | medium | robustness | IMPLEMENT | Lens view failures are swallowed or leave spinners running; every error alert says 'The catalog refused that' |
| CUI-09 | medium | robustness | IMPLEMENT | New-lens dialog accepts addresses the catalog will refuse, and the address cannot be changed afterwards |
| CUI-10 | medium | efficiency | IMPLEMENT | Redundant upstream requests: the poll restarts on every interval change, a confirm causes extra size and list requests, and each lens open refetches /venues for names |
| CUI-11 | low | correctness | IMPLEMENT | Proxy relabels every answer as application/json, drops upstream headers and round-trips bytes through UTF-8; send() throws on non-JSON |
| CUI-12 | low | robustness | IMPLEMENT | No error boundary: one render exception blanks the whole page; a stored unsaved lens is restored without a shape check |
| CUI-13 | low | correctness | IMPLEMENT | Survey order tracking compares server timestamps with the browser clock |
| CUI-14 | low | code-quality | IMPLEMENT | Dead version-skew fallbacks for first/previous/probing, computed three different ways |
| CUI-15 | low | correctness | IMPLEMENT | Catalog refusals are filed on the wrong rule, and a refused Clear is silent |
| CUI-16 | low | correctness | IMPLEMENT | Unsaved-lens drafts outlive the lens: a recreated address restores the old rules, and a second New Lens silently replaces the first |
| CUI-17 | low | code-quality | IMPLEMENT | Accessibility: loaders are unlabeled, survey results are not announced and fade after 6 s, the actions header cell is empty |
| CUI-18 | low | code-quality | IMPLEMENT | knip does not analyse web/; unused exports and dead parameters pile up |
| CUI-19 | low | robustness | IMPLEMENT | Saving a lens's name or note does not lock the button, and the name is trimmed on create but not on save |
| CUI-20 | low | efficiency | IMPLEMENT | Symbol filter re-renders thousands of Mantine Badges on every keystroke |
| CUI-21 | high | security | DEFER | catalog-ui port published on all interfaces with no auth of its own |
| CUI-22 | medium | correctness | DEFER | Lens editor writes the whole definition from a stale local copy: concurrent edits are lost with no warning |
| CUI-23 | low | security | DEFER | Container hardening: whole repo mounted read-write, health port published on all interfaces, upstream URL in 502 bodies |
| CUI-24 | low | code-quality | DEFER | Split Lenses.tsx (1,260 lines) and Surveys.tsx (843 lines) so their pure logic can be exported and tested |
| CUI-25 | low | config | DEFER | Prospector address is a hard-coded constant, so a host `pnpm dev` cannot reach surveys |

## CUI-01: Proxy is an open relay: every method and path is forwarded to the catalog and prospector's private API with the token attached

- **Severity:** critical
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/src/api/routes.ts:29-31`, `services/catalog-ui/src/api/routes.ts:52-68`, `services/catalog-ui/docker/compose.yml:47-52`, `services/prospector/src/api/lenses.ts:7-15`, `services/prospector/src/api/reports.ts:12-24`, `services/catalog/src/api/reports.ts:19`, `docs/modules/ARCHIVES.md:61-62`

**Problem.** routes.ts mounts `app.use('/api/catalog', forward(...))` and `app.use('/api/prospector', forward(...))`. Both forward any method and any sub-path, and add `x-catalog-token` whenever the token is set. catalog-ui checks nothing, and compose publishes it on all interfaces. Anyone who can reach port 9020 therefore gets token-level access to the whole catalog API and the whole of prospector's private API. That includes routes the page never calls: prospector POST/PUT/DELETE /lenses, which skips the catalog's problemsWith validation ('nothing is validated again'); prospector POST /reports, where markDownloaded on arbitrary ids makes hauler stop fetching those files so the archive silently gets gaps; and catalog POST /listings/report.

**Evidence.** Reproduced independently by two reviewers and a verifier against the built dist/src/api/routes.js with a stub upstream. GET /api/catalog/x with no credentials reached upstream with tok=sekret. POST /api/prospector/reports {downloaded:[1,2,3]} and PUT/DELETE /api/prospector/lenses/foo all reached upstream with the token. compose.yml:52 `- ${CATALOG_UI_PORT:-9020}:8080` has no bind address. The page only uses catalog GET /venues, /venues/:v, /venues/:v/symbols, /venues/:v/markets/:m, /venues/:v/markets/:m/symbols, /lenses, /lenses/options, /lenses/:slug/size, POST /lenses, PUT/DELETE /lenses/:slug, and prospector GET /status plus POST /surveys, /surveys/pause, /venues/:v/surveys. Absolute-form request targets currently fail with a 502, so there is no SSRF today, but only by luck.

**Fix.** In routes.ts, replace the two wildcard mounts with an explicit allowlist of (method, path-pattern) pairs. Use explicit app.get/post/put/delete routes, or keep app.use and check req.method plus req.path against regexes. Catalog: GET/HEAD ^/venues$, ^/venues/[^/]+$, ^/venues/[^/]+/symbols$, ^/venues/[^/]+/markets/[^/]+$, ^/venues/[^/]+/markets/[^/]+/symbols$, ^/lenses$, ^/lenses/options$, ^/lenses/[^/]+/size$; POST ^/lenses$; PUT and DELETE ^/lenses/[^/]+$. Prospector: GET ^/status$; POST ^/surveys$, ^/surveys/pause$, ^/venues/[^/]+/surveys$. Before finalising, grep web/ for patch( (it is defined but unused, see CUI-18) and for any other path. Answer everything else under /api/catalog and /api/prospector with 404 JSON {error:'Not forwarded'}. In particular, never forward prospector /lenses* or /reports, or catalog /listings/report, /lenses/resolve, /partitions or /listings. Keep forwarding the query string. Build the upstream URL as `new URL(req.path + search, base)` and assert its origin equals the base's origin, so the URL is safe by construction. Update CATALOG-UI.md's proxy section and diagram, and change ARCHIVES.md so it no longer implies that CATALOG_TOKEN protects an exposed catalog-ui port. Binding and auth are deferred to CUI-21.

**Tests to add.** tests/routes.test.ts with a stub upstream on an ephemeral port. Allowed routes reach upstream with the token and the query string intact. POST /api/prospector/reports, PUT/DELETE /api/prospector/lenses/x and POST /api/catalog/listings/report answer 404 and never reach upstream. An unlisted method on an allowed path (DELETE /api/catalog/venues) answers 404. GET /api/catalog/venues/a%2Fb is forwarded. An absolute-form target never reaches a foreign host.

**Verifier notes.** Lens A: the first verifier rated it high (exposing the page's own write paths is partly by design, since this is the operator console) and the second rated it critical (token defeated, data loss through /reports). Lens B rated it high twice. Consolidated as critical, because the default compose exposes token-level writes that silently remove data from the archive. The first verifier added catalog /listings/report, which the original finding missed.

## CUI-02: Cross-site simple POSTs become authenticated JSON writes (CSRF): any page an operator visits can start or pause every survey

- **Severity:** high
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/src/api/routes.ts:52-68`, `services/catalog-ui/src/api/routes.ts:59-67`, `services/prospector/src/api/collector.ts:20-24`

**Problem.** forward() ignores the incoming Content-Type. It always sends `content-type: application/json` with `JSON.stringify(req.body ?? {})`. express.json leaves req.body undefined for text/plain or form bodies, which browsers send cross-origin without a preflight. The proxy therefore turns a hidden form or a no-cors fetch into an authenticated `{}` POST. For /api/prospector/surveys that starts and enrols every venue for good, and for /api/prospector/surveys/pause it pauses every venue. Origin, Sec-Fetch-Site and Host are not checked either, so DNS rebinding also works.

**Evidence.** Reproduced three times. A text/plain POST with body 'x' to the pause path returned 200, and upstream received ct=application/json, tok=secret, body='{}'. A form-urlencoded POST to /api/prospector/surveys was forwarded the same way. A request with Host: evil.example was accepted. Note: the original repro used /api/catalog/surveys/pause, which has no catalog route. The real targets are under /api/prospector.

**Fix.** Add middleware ahead of the forwarders. For any method other than GET/HEAD/DELETE, answer 415 unless req.is('application/json'). This forces a cross-origin preflight, which fails because no CORS headers are sent. Exempt DELETE because it always needs a preflight; web/api.ts remove() sends no body. Also answer 403 when Sec-Fetch-Site is present and not 'same-origin', or when an Origin header is present and its host differs from req.headers.host. Forward a body only when req.body is defined, and never invent {}. Send content-type upstream only when a body is sent. Optional: a CATALOG_UI_HOSTS env var (comma-separated list, unset means no check) that rejects any other Host, to block DNS rebinding. The default stays off because a strict list would break remote access by hostname.

**Tests to add.** A text/plain POST to /api/prospector/surveys/pause gets 415 and never reaches upstream. A form-urlencoded POST gets 415. A JSON POST with Origin http://evil.example gets 403. A same-origin JSON POST is forwarded with the token. A DELETE with no body is forwarded. A GET sends no content-type and no body. With CATALOG_UI_HOSTS set, a foreign Host gets 403.

**Verifier notes.** Lens A's first verifier rated it medium: CSRF can only send an empty body, so the impact is limited to starting or pausing surveys, and PUT/DELETE need a preflight. Lens B's two verifiers (where it was merged into F1) rated it high. Consolidated as high, because it needs nothing more than an operator visiting a hostile page.

## CUI-03: Default prod image cannot start: prod.node.Dockerfile runs dist/index.js, but every service builds to dist/src/index.js

- **Severity:** high
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:** `docker/prod.node.Dockerfile:62`, `services/catalog-ui/docker/compose.yml:19`, `services/catalog-ui/package.json:5`, `docker/node/entrypoint.sh:22-23`, `docker/README.md:83`

**Problem.** compose builds `docker/${APP_ENV:-prod}.node.Dockerfile`, so with APP_ENV unset or set to prod the prod image is used. Its CMD runs `dist/index.js`. tsc with composite:true writes to dist/src/, so the container exits with MODULE_NOT_FOUND on every start, and restart: unless-stopped loops it. Every service's package.json `main` points at the same missing file. The dev entrypoint uses dist/src/index.js, and .env.example's APP_ENV=dev hides the bug. The bug is repo-wide: catalog, hauler, hoarder, pipe, prospector, router, stocker and vault are all affected.

**Evidence.** `ls services/*/dist` shows `src tsconfig.tsbuildinfo` (plus web for catalog-ui). `node -e "require.resolve('./dist/index.js')"` fails. A scratch compile produced only dist/src/index.js. The start script and entrypoint.sh use dist/src/index.js.

**Fix.** Change docker/prod.node.Dockerfile:62 to `CMD ["/bin/sh", "-c", "exec node --max-old-space-size=${NODE_MEMORY_MB} dist/src/index.js"]`. Set `"main": "dist/src/index.js"` in every service package.json, or remove `main`, since these are private apps. Rewrite docker/README.md to describe the real files (prod.node.Dockerfile and dev.node.Dockerfile), pnpm, and the dist/src/index.js entry point. Optionally add `RUN test -f services/${SERVICE_NAME}/dist/src/index.js` in the builder stage so a wrong path fails the build instead of the container. Do not change rootDir: that would break the dev entrypoint and the start scripts.

**Tests to add.** CI smoke test: `docker build -f docker/prod.node.Dockerfile --build-arg SERVICE_NAME=catalog-ui .`, then run `node -e "require.resolve('./dist/src/index.js')"` in the image. A cheaper alternative: a script that asserts each service's package.json main resolves after `pnpm build`.

**Verifier notes.** Confirmed high by every verifier in both lenses. All agree the fix belongs in the shared Dockerfile, not in catalog-ui alone.

## CUI-04: Proxy ignores client aborts and has no upstream timeout: abandoned requests still queue on the single-threaded catalog

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/src/api/routes.ts:57-70`, `services/catalog-ui/web/api.ts:97-107`, `services/catalog-ui/web/api.ts:139-140`, `services/catalog/src/api/index.ts:43-59`, `docs/services/CATALOG-UI.md:361-363`

**Problem.** The page aborts requests it no longer wants: useAsk cleanup, poll.stop(), and usePolled restarts. forward() calls fetch with no AbortSignal, so the socket to the catalog stays open. The catalog's stillWanted middleware skips queued requests whose socket is destroyed ('One request runs at a time'), but it never sees a disconnect, so it does the synchronous work for nobody. There is no timeout either: a hung upstream holds the request until undici's 300 s headers timeout. CATALOG-UI.md:361-363 promises that the catalog does not start work for a client that has gone, which is false today.

**Evidence.** Reproduced in both lenses. The client aborted at 100-200 ms, and the upstream still served its full 1.5 s response with finished:true.

**Fix.** In forward(): `const gone = new AbortController(); res.on('close', () => { if (!res.writableFinished) gone.abort(); });` and pass `signal: AbortSignal.any([gone.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])`. UPSTREAM_TIMEOUT_MS is a named constant of about 120_000, because api.ts cites 30-second catalog answers. In the catch: if gone.signal.aborted, return without writing or logging; on TimeoutError, answer 504 {error:'No answer from <service> within …'}; otherwise answer 502 as now. Guard everything with `if (res.headersSent) return`. Then make CATALOG-UI.md say exactly what holds: an abort reaches the catalog, which skips a request that has not started; a request already running completes.

**Tests to add.** A stub upstream that delays 1 s and records req.socket 'close'. Abort the client after 100 ms and assert that the upstream socket closed before it answered. A stub that never answers, with a short timeout injected, gets 504.

**Verifier notes.** Lens B's verifier rated it low, believing the catalog has no close handling. That is wrong: I read services/catalog/src/api/index.ts:43-59, and the stillWanted middleware checks req.socket.destroyed after a setImmediate, so propagating the abort does stop queued work (not running work). Lens A's verifier rated it medium, and that rating is kept.

## CUI-05: No tests at all, and `vitest run` exits 1 because vite.config's root:'web' limits discovery

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/package.json:10-11`, `services/catalog-ui/vite.config.ts:12-13`, `services/catalog-ui/src/api/routes.ts:52`, `services/catalog-ui/web/api.ts:128`, `services/catalog-ui/web/App.tsx:118`, `services/catalog-ui/web/views/Surveys.tsx:402`, `services/catalog-ui/web/views/Lenses.tsx:326`

**Problem.** The package has `"test": "vitest run"` and no test files. With vite.config.ts `root: 'web'` and no vitest.config, vitest searches only web/ and exits 1 ('No test files found'). The root `pnpm -r test` is therefore red for a reason that has nothing to do with the code. The proxy contract and the stateful page logic (poll, tookEffect, withOne, readRoute/linkTo, choiceOf/chosenOf/onlyOf, byPeriod, bytes) have no tests.

**Evidence.** `npx vitest run` prints `RUN v4.1.11 /home/user/tradebot/services/catalog-ui/web` and `No test files found, exiting with code 1`.

**Fix.** Add services/catalog-ui/vitest.config.ts: `defineConfig({ root: __dirname, test: { include: ['tests/**/*.test.ts?(x)', 'web/**/*.test.ts?(x)'], environment: 'node', passWithNoTests: true } })`. vitest prefers it over vite.config, so the build is unchanged. First pass: tests/routes.test.ts (express.json plus setupRoutes against a stub upstream, with CATALOG_API set before config is imported) and tests/poll.test.ts with fake timers. Then pure tests for exported helpers. Export or extract them where needed (tookEffect, readRoute/linkTo, bytes, addressIsSound). Defer jsdom/@testing-library component tests until the helpers are extracted (CUI-24).

**Tests to add.** Proxy: token present or absent; x-catalog-lens passed through; GET sends no body; POST/PUT send the JSON body; 4xx JSON and an empty 204 pass through; the query string is kept; an unreachable upstream gives 502; /api/where; plus the tests for CUI-01, CUI-02, CUI-04 and CUI-11. poll(): never two requests in flight; now() while busy re-asks exactly once; stop() aborts and drops a late answer; errors keep it scheduling. Pure: tookEffect for every state pair; withOne for confirm, drop and clear across venues; a linkTo/readRoute round trip with '/', '?', '%' and malformed encoding; choiceOf/chosenOf/onlyOf; byPeriod ordering; bytes() at 1023, 1024 and the PB cap.

**Verifier notes.** Both lenses confirmed medium. The config fix is trivial. The suite is M-L effort and can be added in pieces.

## CUI-06: CATALOG-UI.md and README contradict the code: nonexistent features, validations nobody performs, broken guarantees

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG-UI.md:16-20`, `docs/services/CATALOG-UI.md:32-35`, `docs/services/CATALOG-UI.md:56`, `docs/services/CATALOG-UI.md:169-171`, `docs/services/CATALOG-UI.md:324-329`, `docs/services/CATALOG-UI.md:332-333`, `docs/services/CATALOG-UI.md:345-353`, `docs/services/CATALOG-UI.md:361-363`, `docs/services/CATALOG-UI.md:375-376`, `services/catalog-ui/README.md:25-27`, `services/catalog-ui/README.md:33`, `services/catalog-ui/README.md:40`, `services/catalog-ui/web/views/Surveys.tsx:15-16`

**Problem.** These statements are false today. (a) :16-17 says 'does not hold state … no cache, no session', but the page keeps lens drafts, the unsaved lens, sizes and the last lens in localStorage, and caches /lenses/options per page load. The same doc says so at :335-359. (b) :18-20 says it 'never derives a figure', but it computes downloaded bytes and percentage, 'files - pending', durations, 'N of M', and the stalled/backfilling words. (c) :32-35 says prospector's API is private, but catalog-ui re-exposes it (CUI-01). (d) :56 says answers are 'handed back unchanged' (CUI-11). (e) :324-329 says the catalog refuses rules that 'include nothing' or an 'empty list', but problemsWith checks neither ('What a rule matches is never weighed', draft.ts:117-121). (f) :345-347 names the bundle choices 'Both / Per instrument / Buckets', but the UI offers Any, Only or Prefer per Instrument and Market Bundles. (g) :349-352 describes an instrument search that does not exist ('A rule never names an instrument'). (h) :361-363 says aborts stop catalog work, which is false through the proxy (CUI-04). (i) :169-171 contradicts Surveys.tsx:15-16 on whether a killed container leaves a venue stalled. (j) :375-376 says dev 'behaves exactly as in the container', but PROSPECTOR_API is a constant http://prospector:8080, so a host dev run cannot reach surveys. (k) README:25-27 says lenses are 'sized before it is saved, and refused where it claims more than a venue publishes', which contradicts the doc's 'A draft is never sized' and the validator. (l) README:40 gives the build as 'vite build && tsc -b', but the script is `tsc -p web && vite build && tsc -b`.

**Evidence.** Each item was checked against the code by both lenses' verifiers. Lens A cited the README at :12-14 and :27; the verified lines are :25-27 and :40.

**Fix.** Rewrite docs/services/CATALOG-UI.md from the code. 'What it is not': no server-side state; per-browser drafts, the unsaved lens, size hints and the last lens in localStorage; lens options cached for the life of the page. 'Derives only presentation': shares, durations, 'N of M', the stalled/backfilling words. Proxy section: describe what routes.ts does after CUI-01, CUI-02, CUI-04 and CUI-11 (forwarded routes, which headers pass, JSON-only writes, status/content-type/body preserved, abort propagation and its limit). Keep the proxy contract only here, and trim the routes.ts:7-24 docblock to code-level facts. Delete the 'include nothing'/'empty list' sentences and point to the lens package's doc for what is refused. Replace :345-352 with the real Any/Only/Prefer choices (Prefer is not offered on an exclude) and delete the instrument-search paragraph. Settle the stalled causes in one place (see CUI-07). Dev paragraph: say that dev reaches the catalog through CATALOG_API, and that Surveys works only where prospector:8080 resolves (unless CUI-25 changes that). README: lenses are edited as rules per venue, malformed rules are refused by the catalog, saved lenses show their size; link CATALOG-UI.md; fix the build comment; drop 'such as the one hauler downloads', which documents a non-provider.

**Tests to add.** None (docs). After the rewrite, grep the doc for every UI control it names and confirm each exists in web/.

**Verifier notes.** Confirmed medium by both lenses. The user explicitly asked for an accurate documentation baseline. Do this after the proxy fixes so the proxy section describes the final behaviour.

## CUI-07: Docs and docblocks break CLAUDE.md: history narration, prospector/venue internals in a consumer doc, wrong service attribution, misplaced docblocks

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG-UI.md:43`, `docs/services/CATALOG-UI.md:119`, `docs/services/CATALOG-UI.md:127-130`, `docs/services/CATALOG-UI.md:143`, `docs/services/CATALOG-UI.md:163-185`, `docs/services/CATALOG-UI.md:210-223`, `docs/services/CATALOG-UI.md:244-248`, `docs/services/CATALOG-UI.md:255-259`, `docs/services/CATALOG-UI.md:273`, `services/catalog-ui/web/views/Surveys.tsx:13-25`, `services/catalog-ui/web/views/Surveys.tsx:163-167`, `services/catalog-ui/web/views/Surveys.tsx:236-242`, `services/catalog-ui/web/views/Surveys.tsx:386`, `services/catalog-ui/web/views/Surveys.tsx:466-469`, `services/catalog-ui/web/views/Surveys.tsx:563-570`, `services/catalog-ui/web/views/Surveys.tsx:601-604`, `services/catalog-ui/web/views/Surveys.tsx:665-670`, `services/catalog-ui/web/views/Table.tsx:136-168`, `services/catalog-ui/web/App.tsx:196`, `services/catalog-ui/web/App.tsx:212-213`, `services/catalog-ui/web/api.ts:118`, `services/catalog-ui/web/style.css:599-603`, `services/catalog-ui/web/style.css:666-667`, `services/catalog-ui/web/types.ts:115-121`, `services/catalog-ui/web/types.ts:199-202`, `services/catalog-ui/web/views/Lenses.tsx:1096-1107`, `services/catalog-ui/web/views/Symbols.tsx:6-12`, `services/catalog-ui/src/service.ts:7-10`, `services/catalog-ui/src/api/routes.ts:22`

**Problem.** (1) History, which breaks 'only what is true today': 'used to read `Never`' (Table:138), 'the row used to read' (Surveys:24), 'Wider than it was … used to be three words' (Surveys:163-166), 'handed the row's buttons back' (Surveys:240), 'It used to be a column of its own' (Surveys:563), 'This column used to report' (Surveys:665), 'the previous version rendered these' (App:196/213), 'was six requests queued' (api.ts:118), 'on those rows the button vanished' / 'A grid was the wrong tool' (style.css), and 'which is what it was', 'It took whatever … before', 'used to have no way to ask for', 'no longer one of them' (CATALOG-UI.md). (2) Dependency direction and one home: CATALOG-UI.md explains prospector and venue internals in depth (keys for unlistable venues, resumption 'within milliseconds', Bybit's two servers, okx/bitget serving no listing), and Surveys.tsx docblocks repeat venue facts (binance 'four', okx, bitget, gate). (3) Wrong attribution: /status, `starting`, `surveying`, `first`, `previous`, `probing` and the walk/update mechanisms are credited to 'the catalog' or 'this process' when they belong to prospector. service.ts:7-10 says every answer comes from the catalog's API. (4) Contradiction: three places give three different answers on what leaves a row stalled. (5) Docblocks on the wrong declaration: types.ts 'Where a venue stands…' sits on SurveyState but describes Status; the Lens docblock sits on RuleEntry; Month's docblock sits above EFFECT_TINT; the SymbolList 'Filtered rather than paged' docblock is stacked above SymbolsPanel's. The LastSurvey docblock says 'the kind is shown', but the badge shows the occasion and the kind is in the tooltip.

**Evidence.** Each phrase was verified at the cited line by verifiers in both lenses. /status is served by prospector/src/api/collector.ts:26-30 via statusOf. Line numbers in types.ts have drifted (the file is now 320 lines), and the verified positions are listed.

**Fix.** Delete every history clause and keep only the present-tense rule (e.g. Table.tsx:136-139: 'A pass in flight has a null completion time, so the badge says it is in progress rather than Never'). Replace the venue- and prospector-specific explanations in CATALOG-UI.md :127-130, :163-185, :210-223 and :255-259 with one line each pointing to PROSPECTOR.md or docs/venues (e.g. 'Refresh is disabled where /status reports listable: false; see PROSPECTOR.md'). Remove venue names from the Surveys.tsx docblocks. Say 'prospector' wherever the subject is /status or survey mechanics. Make service.ts:7-10 name both APIs. State the stalled causes once, in CATALOG-UI.md, taking prospector's documented behaviour as the reference, and make the Surveys.tsx:13-17 and :569-570 comments agree or point there. Move each orphan docblock onto its declaration (Status, Lens, Month, SymbolList/Filtered) and give SurveyState a one-line doc. Make LastSurvey's docblock say the badge names the occasion and the tooltip the mechanism. Move LastSurvey and howOf from Table.tsx into Surveys.tsx (their only importer), so Table.tsx's 'shared pieces' docblock stays true.

**Tests to add.** None (docs). Run `grep -rnE 'used to|previous version|no longer|was .* now' services/catalog-ui docs/services/CATALOG-UI.md` and expect it to come back empty.

**Verifier notes.** Merges lens A F13 (low), lens B F5 (medium) and the docblock half of lens B F12 (low). Rated medium overall because of the user's explicit documentation clean-up request. The completedEver comment at Surveys.tsx:150-156 is handled by CUI-14.

## CUI-08: Lens view failures are swallowed or leave spinners running; every error alert says 'The catalog refused that'

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Lenses.tsx:57-74`, `services/catalog-ui/web/views/Lenses.tsx:115`, `services/catalog-ui/web/views/Lenses.tsx:140`, `services/catalog-ui/web/views/Lenses.tsx:233`, `services/catalog-ui/web/views/Lenses.tsx:251-263`, `services/catalog-ui/web/views/Lenses.tsx:460`, `services/catalog-ui/web/views/Lenses.tsx:632-648`, `services/catalog-ui/web/views/Table.tsx:32`

**Problem.** (1) A failed first GET /lenses leaves lenses null, so the Loader spins beside the error alert and nothing retries. (2) The size poll has no error callback, so a 404 or 502 is dropped and the dots Loader spins while requests keep failing. (3) usePublished swallows a failed /lenses/options, and every picker shows 'Nothing found' with no explanation. On success the result is cached for the life of the page. (4) A failed /venues fetch is discarded, and venues without rules vanish from the editor. (5) Waiting's and Lenses' alerts always say 'The catalog refused that', even for prospector /status and for network failures.

**Evidence.** Lenses.tsx:251-262 calls poll with only `data`. :640 `.catch(() => { asked = null; })`. :233 `.catch(() => undefined)`. Table.tsx:32 `title="The catalog refused that"`, also used by Surveys. The verifier noted that poll keeps rescheduling, so the size does appear once the catalog recovers.

**Fix.** (a) Render the list Loader only when `lenses === null && error === null`, and add a Retry action to the error Alert that calls load(). (b) Track sizeError in Editing: `error: err => { if (err.name !== 'AbortError') setSizeError(err.message); }`. Clear it in `data`, and show dimmed error text in place of the dots Loader. (c) usePublished returns {options, error}, and Editing shows one Alert when error is set. Optionally drop the module cache after 60 s or when no instance is mounted. (d) Remove the /venues fetch (CUI-10 c) or surface its failure. (e) Give Waiting a `title` prop that defaults to 'Request failed'. Surveys passes 'Prospector could not answer', and Lenses uses a neutral title.

**Tests to add.** With a fetch mock that rejects (needs a jsdom/RTL harness): error text shows, and no Loader remains for the size or the lens list. Otherwise test usePublished's error path as a function.

**Verifier notes.** Lens B F8, confirmed medium. Absorbs the alert-title part of lens A F7.

## CUI-09: New-lens dialog accepts addresses the catalog will refuse, and the address cannot be changed afterwards

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Lenses.tsx:1220-1224`, `services/catalog-ui/web/views/Lenses.tsx:1240-1252`, `services/catalog-ui/web/views/Lenses.tsx:295-307`, `shared/lenses/src/draft.ts:204`, `services/catalog/src/api/lenses.ts:55-58`

**Problem.** Naming only trims and lower-cases a typed address, and enables Create at length 2 or more unless the address is taken. The catalog accepts only /^[a-z0-9][a-z0-9-]{1,63}$/. The lens lives only in localStorage until its first Save or Confirm, so a bad address ('cold_store', '-x', 65 characters) is discovered only then: a 400 with no problems. Editing has no address field, so every rule drafted under that address is stuck.

**Evidence.** Lenses.tsx:1242 `setSlug(event.currentTarget.value.trim().toLowerCase())`. :1252 `disabled={addressed.length < 2 || clash}`. lensNameIsSound is in draft.ts.

**Fix.** Add an exported helper `addressIsSound(slug)` using the same regex as lensNameIsSound. Import it if draft.ts is browser-safe (check that it has no node imports); otherwise copy it with a comment naming its source. Set the input error to 'Lower case, digits and hyphens; 2 to 64 characters, not starting with a hyphen' and disable Create while the address is unsound or clashes.

**Tests to add.** addressIsSound: false for 'cold_store', 'cold store', '-x', 'a' and a 65-character slug; true for 'cold-store', 'ab' and a 64-character slug.

**Verifier notes.** Lens B F10, confirmed medium.

## CUI-10: Redundant upstream requests: the poll restarts on every interval change, a confirm causes extra size and list requests, and each lens open refetches /venues for names

- **Severity:** medium
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Surveys.tsx:32-33`, `services/catalog-ui/web/views/Surveys.tsx:55-58`, `services/catalog-ui/web/views/Surveys.tsx:824-838`, `services/catalog-ui/web/api.ts:181`, `services/catalog-ui/web/views/Lenses.tsx:228-236`, `services/catalog-ui/web/views/Lenses.tsx:246-266`, `services/catalog-ui/web/views/Lenses.tsx:313-317`

**Problem.** (a) usePolled depends on everyMs, which toggles whenever orders becomes empty or non-empty. Each toggle aborts the in-flight /status and fires a new one at once, so a click costs about three /status computations. (b) store() calls sizing.now(), then onStored → load(). The new updatedAt restarts the sizing poll, which aborts the size request just sent, and the full lens list is fetched again although the PUT answer already holds the stored lens. (c) Editing fetches the full /venues contents on every mount just to collect names, which /lenses/options already carries.

**Evidence.** Surveys.tsx:838 `}, [path, everyMs]);` together with api.ts:181 `run();`. Lenses.tsx:317 `sizing.current?.now(); onStored(lens.slug);` with effect deps at :266. Lenses.tsx:231-232 maps /venues items to venue names.

**Fix.** (a) Let poll take `everyMs: number | (() => number)` and read it at each setTimeout. In usePolled, keep everyMs in a ref, pass `() => ref.current`, and drop everyMs from the effect deps. act() already calls again() after the POST. (b) Remove the explicit sizing.current?.now(). Optionally have onStored take the stored Lens and splice it into the list instead of calling load(). (c) Derive venues from usePublished(): `[...new Set(published.map(o => o.venue))].sort()`, and delete the /venues fetch.

**Tests to add.** poll with fake timers: changing the interval function neither aborts nor fires an immediate request, and the next wait uses the new interval.

**Verifier notes.** Lens B F7, confirmed medium. (a) and (c) matter most.

## CUI-11: Proxy relabels every answer as application/json, drops upstream headers and round-trips bytes through UTF-8; send() throws on non-JSON

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/src/api/routes.ts:43-50`, `services/catalog-ui/src/api/routes.ts:62-63`, `services/catalog-ui/src/api/routes.ts:70`, `services/catalog-ui/web/api.ts:40-49`, `docs/services/CATALOG-UI.md:56-59`

**Problem.** `res.status(answer.status).type('application/json').send(await answer.text())` labels everything JSON (including Express's HTML 404s), drops every upstream header and decodes the body as UTF-8. The proxy also forces `accept: application/json`, and sends content-type on GETs. The docblock ('Unchanged is the whole contract') and CATALOG-UI.md:56 ('handed back unchanged') overstate what it does. In web/api.ts, send() (used for lens POST/PUT) calls JSON.parse without a try/catch, so an HTML 'Cannot PUT …' 404 throws a SyntaxError instead of showing the status.

**Evidence.** Repro: an application/octet-stream answer of ff fe 00 41 reached the client as application/json, ef bf bd ef bf bd 00 41. A text/xml answer was relabelled. The verifier found the practical impact small: the forced Accept means listings come back as JSON, neither service uses rateLimit (so no Retry-After is lost), and neither serves binary.

**Fix.** Minimal: `res.status(answer.status); const ct = answer.headers.get('content-type'); if (ct) res.type(ct); res.send(Buffer.from(await answer.arrayBuffer()));`. Pass the client's Accept through when present (defaulting to application/json). Send content-type upstream only when a body is sent (shared with CUI-02). In web/api.ts send(), wrap JSON.parse in a try/catch that falls back to `{ error: text.slice(0, 300) }`. Reword the routes.ts docblock and CATALOG-UI.md:56-59 to say exactly what is preserved: status, content type and body bytes. Full streaming with hop-by-hop header filtering is not warranted.

**Tests to add.** An upstream text/plain 404 'Cannot PUT /x' reaches the client as 404 text/plain. Binary bytes arrive unchanged. send() given an HTML body returns {status, body:{error}} and does not throw.

**Verifier notes.** Downgraded from medium to low by the verifier, who chose the minimal fix over streaming.

## CUI-12: No error boundary: one render exception blanks the whole page; a stored unsaved lens is restored without a shape check

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/main.tsx:121-127`, `services/catalog-ui/web/App.tsx`, `services/catalog-ui/web/views/Lenses.tsx:47`, `services/catalog-ui/web/views/Lenses.tsx:553-558`

**Problem.** There is no ErrorBoundary anywhere, so any render exception unmounts the whole tree, and Surveys, Contents and Lenses all go blank. unsavedLens() parses localStorage without checking its shape, and entriesOf reads definition.venues, so a stored value with an unexpected shape crashes the Lenses tab on every load.

**Evidence.** grep finds no ErrorBoundary. main.tsx renders <App/> bare. Lenses.tsx:555 `JSON.parse(localStorage.getItem(UNSAVED) ?? 'null') as Lens | null`. The verifier noted that prospector always sends series and lastRun, so the version-skew crash paths named in the finding need an actual contract break.

**Fix.** Add a class ErrorBoundary in web/views (getDerivedStateFromError, and componentDidCatch with console.error) that renders a Mantine Alert with the message and a 'Try again' reset. Wrap each section in App.tsx, keyed on the route. unsavedLens(): return null unless `typeof v?.slug === 'string' && typeof v?.definition?.venues === 'object'`. Make entriesOf tolerate a missing venues. Do not guard required fields such as series: the boundary now reports a contract break instead of hiding it.

**Tests to add.** A render test: a child that throws inside the boundary shows the Alert, and sibling sections still render. unsavedLens returns null for {foo:1}.

**Verifier notes.** Lens A F7, downgraded from medium to low. The alert-title part moved to CUI-08.

## CUI-13: Survey order tracking compares server timestamps with the browser clock

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Surveys.tsx:50`, `services/catalog-ui/web/views/Surveys.tsx:105-117`, `services/catalog-ui/web/views/Surveys.tsx:414-416`, `services/catalog-ui/web/views/Surveys.tsx:773`, `services/catalog-ui/web/types.ts:132-141`

**Problem.** tookEffect compares `Date.parse(now.lastRun.startedAt)` (server clock) with `order.at = Date.now()` (browser clock), allowing 5 s of slack. If the browser runs fast, a quick pass between two polls is never seen, and the page wrongly says the catalog did not act. If it runs slow, an earlier pass counts, and the row is released while the order is still in flight.

**Evidence.** Surveys.tsx:414-416 `return began >= order.at - 5_000;`.

**Fix.** Add `fromStartedAt: string | null` to Order and capture it in act() from the current row's lastRun.startedAt. In tookEffect, replace the time comparison with `now.lastRun.startedAt !== null && now.lastRun.startedAt !== order.fromStartedAt`, and keep the GOING and unpaused branches. Keep `at: Date.now()` only for the local ORDER_MS lapse timer. Due may stay as it is.

**Tests to add.** tookEffect: waiting→waiting with a changed startedAt counts as done; with the same startedAt it does not; a ±60 s browser offset makes no difference; the pause and paused→waiting cases still pass.

**Verifier notes.** Lens A F8, confirmed low.

## CUI-14: Dead version-skew fallbacks for first/previous/probing, computed three different ways

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/types.ts:55-66`, `services/catalog-ui/web/types.ts:182`, `services/catalog-ui/web/views/Surveys.tsx:150-157`, `services/catalog-ui/web/views/Surveys.tsx:194`, `services/catalog-ui/web/views/Surveys.tsx:615`, `services/catalog-ui/web/views/Surveys.tsx:684`, `services/catalog-ui/web/views/Surveys.tsx:701`, `services/prospector/src/types.ts:2384`, `services/prospector/src/types.ts:2442-2449`

**Problem.** web/types.ts marks LastRun.first, LastRun.previous and Status.probing optional 'because a page is served before the catalog behind it is restarted'. Prospector declares them required and always sets them. The UI still falls back with `?? ! completedEver` (at 157, 615 and 684) and `v.probing ?? kind === 'update'` (at 194). The comment at Surveys.tsx:150-156 says the fallback is applied once, but it is repeated in three places.

**Evidence.** prospector/src/types.ts:2384 `probing: boolean`, :2442 `first: boolean`, :2449 `previous: FinishedRun | null`.

**Fix.** Make first, previous and probing required in web/types.ts and delete the skew comment. Use `v.lastRun.first` at 157 (pass lastRun to LastSurvey unchanged and delete the comment at 150-156), `of.lastRun.first` at 615 and `run.first` at 684. Change line 194 to `v.wip > 0 || v.probing`. Use run.previous directly. Leave line 701 unchanged, because it asks whether the next pass is a backfill and completedEver answers that. Add a one-line comment there saying so. Let `tsc -p web` find any remaining `??` uses.

**Tests to add.** Covered by tsc. Optionally render LastSurvey with first true and false.

**Verifier notes.** Lens B F6, downgraded to low. The verifier refuted the failure scenario and rejected the suggestion to change line 701 (it would label daily updates 'Backfill starting…'). Lens A F13's firstOf suggestion is superseded: once the fallback is gone, all three sites read lastRun.first directly.

## CUI-15: Catalog refusals are filed on the wrong rule, and a refused Clear is silent

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Lenses.tsx:301-309`, `services/catalog-ui/web/views/Lenses.tsx:326-340`, `services/catalog-ui/web/views/Lenses.tsx:355-369`, `services/catalog-ui/web/views/Lenses.tsx:483-486`, `services/catalog-ui/web/views/Lenses.tsx:892`

**Problem.** problemsWith returns {venue, rule, field} for every bad rule in the whole definition. store() files every rule>=0 problem under the key being stored, so a fault in another rule shows on the card just confirmed. For Clear (key `clear:${venue}`), no card renders that key, general receives only rule<0 problems, and onFailed runs only when there are no problems at all. A refused Clear therefore shows nothing.

**Evidence.** Lenses.tsx:304 `[key]: found.filter(one => one.rule >= 0)`. :307 `if (found.length === 0) onFailed(...)`. The claim about saving a new lens was refuted: save() sends empty venues.

**Fix.** Have withOne also return a map from (venue, index in the sent list) to entry key, counting only the entries actually pushed. In store(), file each problem under its mapped key, and put unmapped and rule<0 problems in general. Call onFailed(body.error) whenever status >= 400 and no problem landed on a rendered card or in general.

**Tests to add.** A definition with a bad rule at venue B index 1, then a confirm on venue A: the problem appears on B's entry, not A's. A Clear refused with rule problems surfaces them.

**Verifier notes.** Lens A F9, partly confirmed, low.

## CUI-16: Unsaved-lens drafts outlive the lens: a recreated address restores the old rules, and a second New Lens silently replaces the first

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Lenses.tsx:149`, `services/catalog-ui/web/views/Lenses.tsx:155`, `services/catalog-ui/web/views/Lenses.tsx:216-218`, `services/catalog-ui/web/views/Lenses.tsx:527-535`, `services/catalog-ui/web/views/Lenses.tsx:1189`, `services/catalog-ui/web/views/Lenses.tsx:1251`

**Problem.** An unsaved lens has updatedAt ''. Its draft is stored under its address with from ''. onGone clears UNSAVED but not the draft key, so a lens recreated with the same address matches ('' === '') and the deleted lens's name, note and rules replace what was just typed. onNamed also replaces an existing unsaved lens without warning. Deleted saved lenses leave their draft and size keys behind (litter only).

**Evidence.** Lenses.tsx:535 `draft.from === lens.updatedAt`. :149 onGone never calls keep(lens, null).

**Fix.** On deletion (both paths through Removing), call keep(lens, null) and remove sizeKey(lens.slug) inside a try/catch. Stamp unsaved lenses with `updatedAt: `unsaved:${Date.now()}`` and treat that prefix as unsaved wherever updatedAt is displayed or used for sizing. If an unsaved lens already exists, confirm before replacing it (and clear its draft) or disable New Lens with a tooltip.

**Tests to add.** keptFor/keep unit test, or a component test: create, draft, delete, recreate with the same address, and expect no revived draft.

**Verifier notes.** Lens A F10, confirmed low.

## CUI-17: Accessibility: loaders are unlabeled, survey results are not announced and fade after 6 s, the actions header cell is empty

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Table.tsx:41-42`, `services/catalog-ui/web/views/Lenses.tsx:140`, `services/catalog-ui/web/views/Lenses.tsx:451`, `services/catalog-ui/web/views/Lenses.tsx:460`, `services/catalog-ui/web/views/Surveys.tsx:79-81`, `services/catalog-ui/web/views/Surveys.tsx:115-117`, `services/catalog-ui/web/views/Surveys.tsx:230`, `services/catalog-ui/web/views/Surveys.tsx:330`, `services/catalog-ui/web/views/Surveys.tsx:797-805`

**Problem.** Loaders have no role or label. said.text, which includes failures such as a 502 on Pause All, is plain Text with no live region and fades after 6 s, so a failure is easy to miss for anyone. The actions column has `head: ''`. Some facts exist only in title attributes.

**Evidence.** Table.tsx:41 `<Loader size="sm" type="dots" />`. Surveys.tsx:330 renders plain Text. useFading clears every message after SAID_MS = 6000.

**Fix.** Loaders: role="status" aria-label="Loading" in Waiting and at Lenses.tsx:140 and :460; aria-hidden at :451, where the text beside it already explains the wait. Always render a `<div role="status" aria-live="polite">` and put said.text inside it. Split useFading into say (fades) and fail (stays until dismissed or the next action), and use fail in act()'s catch and in the lapse message. Optional: a Column `label` for a visually hidden 'Actions' header, and Mantine Tooltips for title-only facts.

**Tests to add.** Render Waiting while loading and assert getByRole('status', {name:'Loading'}). A failed act() message persists past SAID_MS.

**Verifier notes.** Merges lens A F14 and lens B F17. The colour-only draft claim was refuted by both verifiers (the Confirm/Discard/Revert buttons show the state in text), so no Draft badge. window.confirm is not an accessibility defect.

## CUI-18: knip does not analyse web/; unused exports and dead parameters pile up

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:** `knip.json:7-13`, `services/catalog-ui/web/api.ts:57-71`, `services/catalog-ui/web/views/Market.tsx:32`, `services/catalog-ui/web/App.tsx:38-43`, `services/catalog-ui/web/api.ts:91-96`, `services/catalog-ui/web/style.css:51-52`, `services/catalog-ui/src/api/routes.ts:52`

**Problem.** knip's services/** workspace has project src/**/*.ts, so web/ is never checked. patch and put are never imported. variantOf, Section and Route are exported but used only in their own files. useAsk accepts null, but no caller passes it. style.css:51-52 duplicates an inline style. forward() takes a thunk for a constant.

**Evidence.** `npx knip --workspace services/catalog-ui` prints nothing. grep confirms the unused exports. The CSS rule is at style.css:52, not :593 as the finding said.

**Fix.** Add a knip override for services/catalog-ui with entry [src/index.ts, web/main.tsx, vite.config.ts] and project [src/**/*.ts, web/**/*.{ts,tsx}]. Copy `paths`, because the override replaces rather than merges. Re-run knip and confirm it now reports patch and put. Delete patch and put. Un-export variantOf, Section and Route. Narrow useAsk to `path: string` and remove the null branches. Delete style.css:51-52. Make forward take `upstream: string`.

**Tests to add.** knip runs clean for the workspace, and tsc and the build pass.

**Verifier notes.** Lens B F11, confirmed low.

## CUI-19: Saving a lens's name or note does not lock the button, and the name is trimmed on create but not on save

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Lenses.tsx:297`, `services/catalog-ui/web/views/Lenses.tsx:367-375`, `services/catalog-ui/web/views/Lenses.tsx:419`

**Problem.** For a saved lens, save() sends the PUT without setStoring, so a double click sends two PUTs. The name is sent untrimmed on save but trimmed on create.

**Evidence.** Lenses.tsx:370 sends a PUT {name, note} with no setStoring. :297 uses name.trim().

**Fix.** In the saved-lens branch: setStoring('general'), then send {name: name.trim(), note} and await onStored, catching errors into onFailed, with setStoring(null) in finally. Compute general_dirty as `name.trim() !== lens.name || note !== lens.note`.

**Tests to add.** Component test: a second click during the PUT sends nothing.

**Verifier notes.** Lens B F13, confirmed low. The failure scenario (draft loss) is overstated.

## CUI-20: Symbol filter re-renders thousands of Mantine Badges on every keystroke

- **Severity:** low
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/web/views/Symbols.tsx:60-91`

**Problem.** Filtered renders one Badge per symbol ('a few thousand strings') synchronously on every keystroke, so typing lags.

**Evidence.** Symbols.tsx:87 maps kept to Badge, and the input's onChange sets the query on each keystroke.

**Fix.** Compute `kept` from `useDeferredValue(query)`. Replace Badge with a plain span with a small CSS class. Optionally dim the list while the deferred value catches up. The docblock move is in CUI-07.

**Tests to add.** Optional RTL test: render with 3,000 synthetic symbols, type 'BTC', and expect only matches and an updated '· N shown' count (findBy).

**Verifier notes.** Lens B F15, confirmed low.

## CUI-21: catalog-ui port published on all interfaces with no auth of its own

- **Severity:** high
- **Category:** security
- **Decision:** DEFER
- **Locations:** `services/catalog-ui/docker/compose.yml:52`, `services/catalog-ui/src/api/routes.ts`, `docs/modules/ARCHIVES.md:61-62`

**Problem.** After CUI-01 and CUI-02, anyone who can reach port 9020 can still use the page's own write paths: lens writes, starting, pausing and refreshing surveys, with the token. The default compose binds every interface, and catalog-ui has no authentication.

**Evidence.** compose.yml:52 `- ${CATALOG_UI_PORT:-9020}:8080` has no bind address. setupRoutes adds no auth middleware.

**Fix.** Options: (1) default the bind to loopback with `${CATALOG_UI_BIND:-127.0.0.1}:${CATALOG_UI_PORT:-9020}:8080` and document it in the README environment table; (2) an optional CATALOG_UI_PASSWORD (HTTP Basic, compared with timingSafeEqual) in front of every route, or at least every non-GET forward; (3) put a reverse proxy with auth in front. Whichever is chosen, record it in CATALOG-UI.md and make ARCHIVES.md say whether CATALOG_TOKEN protects the UI port.

**Tests to add.** With CATALOG_UI_PASSWORD set, a request without credentials gets 401 and is not forwarded.

**Verifier notes.** This is the deferred half of lens A F1 and lens B F1. All verifiers called binding and auth an owner decision.

## CUI-22: Lens editor writes the whole definition from a stale local copy: concurrent edits are lost with no warning

- **Severity:** medium
- **Category:** correctness
- **Decision:** DEFER
- **Locations:** `services/catalog-ui/web/views/Lenses.tsx:148`, `services/catalog-ui/web/views/Lenses.tsx:216-218`, `services/catalog-ui/web/views/Lenses.tsx:279-281`, `services/catalog-ui/web/views/Lenses.tsx:295-299`, `services/catalog-ui/web/views/Lenses.tsx:326-340`, `services/prospector/src/api/lenses.ts:51-66`

**Problem.** Confirm, Drop and Clear PUT a complete definition rebuilt from the editor's own saved copies. Those copies are set once on mount and never refreshed. The PUT carries no version, and editLens has no precondition, so the last writer wins whole across tabs or editors. Stale drafts are then stored under the new updatedAt.

**Evidence.** Lenses.tsx:218 useState initialiser. :298-299 PUT {definition}. prospector editLens has no version check. Consistent within a single tab.

**Fix.** Add an optional ifUpdatedAt (or If-Match) to the lens write in @tradebot/lenses editLens, returning a 'stale' result. Have the catalog's and prospector's PUT /lenses/:slug map it to 409 {error, lens:<current>}. The UI sends ifUpdatedAt: lens.updatedAt. On 409 it rebuilds rules from the returned lens, keeps the new and changed drafts, and shows an alert. There is no UI-only stopgap, because GET-then-PUT still races.

**Tests to add.** editLens with a stale ifUpdatedAt refuses and leaves the row unchanged. The catalog PUT answers 409. UI merge on 409.

**Verifier notes.** Lens A F6: confirmed medium, implementation deferred by the verifier.

## CUI-23: Container hardening: whole repo mounted read-write, health port published on all interfaces, upstream URL in 502 bodies

- **Severity:** low
- **Category:** security
- **Decision:** DEFER
- **Locations:** `services/catalog-ui/docker/compose.yml:44-45`, `services/catalog-ui/docker/compose.yml:51`, `services/catalog-ui/src/config.ts:23-32`, `services/catalog-ui/src/api/routes.ts:34-36`, `services/catalog-ui/src/api/routes.ts:74`

**Problem.** compose mounts ../../../:/live read-write, including .env files, although the prod image never uses it. `- :3000` publishes the health port on all interfaces. The 502 body includes the full upstream URL.

**Evidence.** Every Node service's compose file has the same mount and publish lines. dev.node.Dockerfile uses WORKDIR /live and keeps its pnpm store there, so dev needs the mount. Credentials in CATALOG_API cannot work, because Node's fetch rejects URLs with userinfo.

**Fix.** Repo-wide: move the /live mount (and optionally the :3000 publish) into a dev-only compose override applied when APP_ENV=dev. Optionally, the catalog-ui 502 body can say 'Could not reach the catalog' while the log keeps the full URL. Stripping userinfo is unnecessary.

**Tests to add.** The 502 body for an unreachable upstream does not contain the configured host.

**Verifier notes.** Lens A F15, confirmed low and deferred: it needs a repo-wide compose decision.

## CUI-24: Split Lenses.tsx (1,260 lines) and Surveys.tsx (843 lines) so their pure logic can be exported and tested

- **Severity:** low
- **Category:** code-quality
- **Decision:** DEFER
- **Locations:** `services/catalog-ui/web/views/Lenses.tsx:1-1260`, `services/catalog-ui/web/views/Surveys.tsx:1-843`

**Problem.** Persistence, definition assembly, option derivation, five components and the page share one module. The order state machine sits next to rendering. None of the pure functions are exported, so none can be tested.

**Evidence.** wc -l: Lenses.tsx 1260, Surveys.tsx 843.

**Fix.** Lenses.tsx: split into web/lenses/storage.ts (keptFor, keep, unsavedLens, keepUnsaved, seenSize, keepSize), web/lenses/definition.ts (withOne, entriesOf, stateOf, chosenOf, choiceOf, onlyOf, choices, byPeriod, seconds), plus Picker, Rule, Month and Naming component files. Surveys.tsx: move tookEffect, without, took and when into web/surveys/orders.ts. Export the pure functions and test them as part of CUI-05.

**Tests to add.** Unit tests for each extracted module (see CUI-05).

**Verifier notes.** This is the refactor half of lens B F12. The verifier said it should be done with tests, not as a drive-by.

## CUI-25: Prospector address is a hard-coded constant, so a host `pnpm dev` cannot reach surveys

- **Severity:** low
- **Category:** config
- **Decision:** DEFER
- **Locations:** `services/catalog-ui/src/config.ts:15-19`, `services/catalog-ui/src/config.ts:24`, `services/catalog-ui/README.md:33`, `docs/services/CATALOG-UI.md:375-376`

**Problem.** PROSPECTOR_API is fixed at http://prospector:8080, so a host dev run always shows 502 for Surveys. This is a deliberate, documented decision ('Private to the module network, so it is a constant'), but it contradicts the doc's claim that dev behaves exactly as in the container.

**Evidence.** config.ts:15-18 docblock. README.md:33 'Prospector is always http://prospector:8080'.

**Fix.** Either read `process.env['PROSPECTOR_API']?.trim() || 'http://prospector:8080'` like CATALOG_API and update the config docblock, the README environment table and the compose comment together, or keep it constant and correct the dev paragraph (CUI-06).

**Tests to add.** config reads PROSPECTOR_API when it is set.

**Verifier notes.** The prospector half of lens B F9. The verifier said it is a deliberate decision, not a bug.

## Deferred: decisions needed

- **CUI-14** (IMPLEMENT): Replacing the hand-mirrored lens types in web/types.ts with `import type` from @tradebot/lenses goes against the stated design ('types are mirrors') and adds a build-order coupling. Keep mirrors, or import?
- **CUI-21** (DEFER): How should remote operators reach the console: loopback-only by default (with SSH tunnels or a reverse proxy), or a built-in password? Binding to 127.0.0.1 changes how existing remote users reach it.
- **CUI-22** (DEFER): Do you want optimistic concurrency on lens writes? It changes the API contract of @tradebot/lenses editLens and of both the catalog's and prospector's PUT /lenses/:slug, for a single-operator console where concurrent edits are plausible but rare.
- **CUI-23** (DEFER): Should the shared compose layout split into prod and dev overrides, so prod containers do not mount the checkout? This affects every service, not only catalog-ui.
- **CUI-24** (DEFER): Schedule the module split as its own refactor, paired with the test suite, before the planned new lens and survey functionality lands?
- **CUI-25** (DEFER): Make PROSPECTOR_API configurable for host dev runs, or keep it a module-private constant and document the dev limitation?

## Rejected

- **Survey actions share one busy slot, so overlapping actions re-enable rows early (lens A F16)**: Refuted. The modal's opener is disabled while busy, the Mantine modal blocks other buttons, and rows stay held by their orders. Optional only: add disabled={busy !== null} to the modal's Refresh button.
- **Static assets uncompressed and without long-lived caching (lens B F14)**: Not worth it for a single-user admin page: about 200 KB gzipped, and ETag revalidation serves 304s. Optional zero-dependency tweak: serve /assets with immutable and maxAge '1y'.
- **Replace the NUL-separated lens key with ?lens= (lens B F16)**: Style preference with no defect: the current code is correct, and the header is the catalog's documented client mechanism. Optional cleanup only.
- **Add a visible 'Draft' badge because draft state is colour-only (lens A F14, lens B F17 part)**: Refuted. A draft shows Confirm/Discard/Revert, a saved rule shows Drop Rule, so the state is conveyed in text.
- **Replace line 701's backfill test with run.first (lens B F6 part)**: Harmful. Line 701 is about the upcoming pass, so run.first would label a daily update 'Backfill starting…'.
- **Proxy loses Retry-After and corrupts XML/binary as a practical problem (lens A F5 part)**: No current upstream sets rateLimit or serves binary, and the forced Accept yields JSON. Only the minimal content-type and bytes fix (CUI-11) is kept.
