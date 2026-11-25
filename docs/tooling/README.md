# Tooling

The repository's two command lines sit at its root and run on the host. Each has one home for its
documentation; this page points to them.

| | what it is | its doc |
|---|---|---|
| `./tb` | the compose wrapper: creates the shared docker network `${PROJECT_NAME}-network` where it is missing, then runs dx, which brings modules up and down, builds, installs and tests services | [README.md](../../README.md#running-one), [dx/README.md](../../dx/README.md) |
| `./tools` | the developer command line, `dev/tooling`: `rabbit`, `monitor`, `cold` and `remote`, how it is built, and the `.env` files it loads | [dev/tooling/README.md](../../dev/tooling/README.md) |

## `./tools cold`

Cold storage of the archives, the vault and the catalog's database in Mega. One page holds what every
cold command shares, and one page each tree:

| page | |
|---|---|
| [COLD.md](COLD.md) | the command shape, origins and shared options, configuration, where things live, locks, the record and its copy in Mega, how Mega is trusted, watching |
| [COLD-ARCHIVES.md](COLD-ARCHIVES.md) | `push`, `evict`, `pull` and `stats` of the archives |
| [COLD-VAULT.md](COLD-VAULT.md) | `push`, `evict`, `pull` and `stats` of the vault, `backedup.csv`, and `pull needed` |
| [COLD-CATALOG.md](COLD-CATALOG.md) | `push catalog` and `pull catalog` |
| [COLD-AUDIT.md](COLD-AUDIT.md) | `audit` |
