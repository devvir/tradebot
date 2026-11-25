# TradeBot dev tools

`./tools` is the repo's developer command line. It runs on the host, not in a container, and holds
four commands: `rabbit`, `monitor`, `cold` and `remote`.

## Running it

`./tools` runs the built package, `dev/tooling/dist/index.js`, so build it first and again after
changing its source:

```bash
pnpm --filter @tradebot/tooling build
./tools                      # interactive menu
./tools rabbit --list        # a command directly
./tools <command> --help     # a command's options
```

Without arguments, and with stdin a terminal, `./tools` opens a menu of the commands; for `cold` it
then asks which subcommand. Arguments that are only `-e`/`-m` options still open the menu and apply
to the command picked from it.

`./tools` runs with the repository root as its working directory, wherever it is called from.

Inside `dev/tooling`, `pnpm dev <args>` runs the source through ts-node without a build, and
`pnpm test` runs the tests.

## Environment

Before any command runs, the tools load `.env` files into the environment. From lowest to highest
precedence:

1. `<repo>/.env`
2. with `-m <name>`: `modules/<name>/.env`, else the one `modules/<group>/<name>/.env`
   (`-m archives` and `-m collect/archives` both name `modules/collect/archives/.env`)
3. `dev/tooling/.env` (see `dev/tooling/.env.example`)
4. with `-e <path>`: that file
5. what the shell exported

A missing root or tooling `.env` is skipped. A missing `-e` file, or a `-m` name that matches no
module, several modules, or a module without a `.env`, stops the command with an error. Relative
`-e` paths are read from the working directory (the repository root under `./tools`).

`${VAR}` references in file values are expanded against the merged result; an unset one becomes
empty, with a warning. Single-quoted values and values the shell exported are used as written.

```bash
./tools -e .env.staging monitor
./tools -m archives cold stats
```

Each command's own variables are listed with the command below; `cold`'s are in
[docs/tooling/COLD.md](../../docs/tooling/COLD.md#configuration).

## `rabbit` (alias `amqp`)

Inspects RabbitMQ queues without taking anything from them.

```bash
./tools rabbit --list                 # every queue: messages, ready, consumers
./tools rabbit <queue>                # the 10 oldest messages
./tools rabbit <queue> --messages 50  # the 50 oldest
./tools rabbit <queue> --watch        # new messages until Ctrl+C
./tools rabbit <queue> --watch --messages 5   # stop after 5
```

- **Fetch** (the default) takes up to `--messages` (default 10) messages from the head of the queue,
  prints them, and requeues all of them. The queue keeps them, marked redelivered. A stream queue
  cannot be fetched from and is refused.
- **`--watch`** prints messages as they are published. For a classic or quorum queue it binds a
  private, auto-deleted queue to the same exchanges with the same routing keys and reads that copy,
  so the queue and its consumers are not touched. Messages published straight to the queue through
  the default exchange are not seen, and a queue bound to no other exchange has nothing to watch. A
  stream queue is read from its next offset. `--messages` stops the watch after that many.
- JSON bodies are pretty-printed; anything else is printed as is.

`--list` and `--watch` need the RabbitMQ management API.

**Which broker.** The first of these that applies:

1. `--url <amqp-url>`
2. `QUEUE_URL` exported by the shell
3. a running container whose image or name contains `rabbitmq` and that publishes port 5672 on the
   host (with several, it asks which); credentials are `QUEUE_USER` and `QUEUE_PASS`, default
   `guest`
4. `QUEUE_URL` from the `.env` files
5. `amqp://QUEUE_USER:QUEUE_PASS@localhost:5672`

A `.env` `QUEUE_URL` comes after discovery because it usually addresses the broker from inside the
compose network, which the host cannot resolve.

**Which management API.** For a discovered container, the host port it publishes 15672 on; a
container that does not publish 15672 has none. Otherwise `RABBITMQ_MGMT_URL` (ending in `/api`),
else the AMQP host on `QUEUE_MGMT_PORT` (default 15672). It is called with the AMQP URL's
credentials.

## `monitor` (alias `mon`)

A live dashboard of the running Docker containers and the RabbitMQ queues, redrawn every
`-i, --interval <seconds>` (default 3, at least 0.5). Ctrl+C stops it.

```bash
./tools monitor -i 1
```

- **Containers**, grouped by compose project: ID, name, health (from the container's healthcheck),
  uptime since the container last started, CPU, memory used/limit, restart count, and time since
  its last log line.
- **RabbitMQ**, one section per running container whose image contains `rabbitmq` and that publishes
  port 15672 on the host: per queue its vhost, ready, unacked and total messages, consumers,
  publish and deliver rates, and state. The management API is called with `QUEUE_USER` and
  `QUEUE_PASS` (default `guest`).

## `cold`

Cold storage of the archives and the vault in Mega: `push`, `evict`, `pull`, `audit` and `stats`.
See [docs/tooling/COLD.md](../../docs/tooling/COLD.md).

## `remote`

`remote sync-env` (or `remote` alone) copies every `.env` file in the repository to the same
relative path on a remote host.

```bash
./tools remote sync-env
# Remote destination (user@host:/remote/path): deploy@10.0.0.1:/srv/tradebot
```

The destination is `user@host:/path` or `user@host:~/dir`, and `user@[ipv6]:...` for an IPv6 host.
It lists the files it found (skipping `node_modules`, `dist` and every directory whose name starts
with a dot) and asks before overwriting. Each file is copied with `ssh` and `scp`: the remote
directory is created under umask 077 and the file set to mode 600. A failed file does not stop the
others; the summary names the failures and the exit code is 1.

## Layout

`src/commands/` registers each command and its options; `src/tools/<tool>/` implements it;
`src/shared/` holds what the tools share (terminal UI, env loading, RabbitMQ connection, Docker
discovery). `tests/` mirrors `src/`.
