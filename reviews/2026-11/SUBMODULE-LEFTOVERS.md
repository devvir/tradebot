# Fixes that belong in the submodule repos (not changeable from this repo)

These came out of the router-pipe implementation (2026-11-25). They need changes in separate repositories
(devvir/service-kit, devvir/rabbitmq) that this session cannot push to.

- **packages/service-kit — RTP-08:** the shutdown plugin should `process.exit(signal === 'ERROR' ? 1 : 0)` so fatal errors exit
  non-zero for every service (pipe now works around it locally).
- **packages/service-kit — RTP-02 (optional):** an `onHealthCheck` passthrough in SKFactory (router uses `service.on('healthCheck')`
  meanwhile); and a keep-alive consumer broker with a raw-delivery option for in-process consumer recovery.
- **packages/rabbitmq — RTP-06:** `declareTopology` should reuse existing Exchange instances on recovery instead of replacing them.
- **packages/rabbitmq — RTP-17:** `Exchange.republish` should publish only the original defined properties (no persistent /
  contentType defaults), so a missing contentType stays missing. (Owner question recorded in router-pipe.md.)
- **packages/rabbitmq — RTP-20:** if the pipe "Recovery" integration test is wanted, re-home it in packages/rabbitmq's suite (it was
  removed from services/pipe).
- **packages/rabbitmq — RTP-03 (DEFER):** publisher confirms needed for at-least-once routing; see router-pipe.md.
- **packages/service-kit/docs/README.md** is an empty file.
- **dx — network name:** dx/utils/docker.js ensureNetworkExists creates `${COMPOSE_PROJECT_NAME||'dx'}-network`, but compose files join `${PROJECT_NAME:-tradebot}-network` (only ./tb creates the right one).
- **packages/rabbitmq — RP-V1 (low):** bare-queue (default-exchange) publishes fail during a publisher channel-only recovery, while named-exchange publishes recover; needs a fix in the broker's recovery path.
