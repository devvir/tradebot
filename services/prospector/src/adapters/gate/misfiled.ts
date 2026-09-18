/**
 * Gate's misfiled months: what is refused, and the one list that survives it.
 *
 * **Gate sometimes writes a period into the wrong month's directory.** The
 * directory says one month and the filename another, which no pattern can
 * express — `{YYYY}{MM}` cannot be December in the path and November in the name
 * — so path derivation keeps the month as a literal and every such file gets a
 * shape of its own.
 *
 * **The shapes are the expensive part, not the files.** A pattern with a literal
 * month can never gain a file generation could reach, since generation fills the
 * filename and leaves the directory fixed — but nothing marks it finished, so its
 * series stay open and ask about every day of the patience window for ever.
 * Measured 2026-09-27: 21 such shapes held 63,506 series, 20,948 of them still
 * counted active, and they produced **312,336 of gate's 323,229 nightly probes**,
 * 97% of that venue's whole backlog.
 *
 * **Nearly every misfiled file is also worthless**, checked against the archive
 * rather than assumed:
 *
 * - The 2024 klines are duplicates: 61,884 of 62,208 have a correctly filed twin
 *   of identical size *and* ETag.
 * - `spot/deals/202108` holds July 2021 truncated — `ADA_USDT` is 1,591 lines
 *   against the proper file's 931,801, sharing its opening rows.
 * - `spot/deals/202106` holds March 2020 of gate's `_USD` pairs, which are
 *   coin-margined **futures** — four columns with a signed size — under a spot
 *   path. `futures_btc/trades/202003/` holds every one at the same byte count, so
 *   catalogued from the spot path they are both a duplicate and a mislabelling.
 * - `futures_btc/trades/202106` holds March 2020 again, same size as the proper
 *   file and a different ETag: recompressed, which gzip's own header explains.
 *
 * **Two things are kept.** The 2022 books hour, because the properly filed
 * directory stops at hour 22 and that hour exists nowhere else — recognised by
 * its stamp carrying an hour, and seeded as three retired patterns. And the 324
 * klines below, which have no twin at all.
 */

/**
 * The klines that are misfiled *and* have no correctly filed copy.
 *
 * **An enumeration, deliberately, and the last resort it looks like.** What
 * separates these from the 61,884 duplicates beside them is whether the same file
 * exists in the right directory — a fact about the archive, not about the path,
 * so no rule can recover it and a list is the only honest form.
 *
 * It is a closed list: the misfiling stopped in December 2024 and has not
 * recurred. 108 instrument-days, each published at three bar lengths — 324 files,
 * 822 KB, klines for instruments that barely traded on the day they stopped.
 */
const KEPT: Record<string, readonly string[]> = {
  20240630: ['AGIX_USDT','DOP_USDT','FARMLAND_USDT','GM_USDT','NOIA_ETH','NOIA_USDT','OCEAN_TRY','OCEAN_USDT','RBN_ETH','RBN_USDT','VERA_ETH','VERA_USDT'],
  20240731: ['ANT_USDT','BOX_USDT','BTF_BTC','BTF_USDT','CATGIRL_USDT','CAT_USDT','COOK_ETH','COOK_USDT','CRPT_ETH','CRPT_USDT','DOCK_ETH','DOCK_USDT','ENV_USDT','FNSA_BTC','FNSA_USDT','FORM_ETH','FORM_USDT','FOUR_USDT','FRONT_ETH','FRONT_TRY','FRONT_USDT','FUEL_USDT','HMTT_USDT','KLAY3L_USDT','KLAY3S_USDT','KLAY_USDT','MATIC_ETH','MATIC_TRY','MATIC_USDC','MATIC_USDT','MURATIAI_USDT','NII_ETH','NII_USDT','NMT_ETH','NMT_USDT','ROUTE_USDT','SCLP_ETH','SCLP_USDT','SMILE_USDT','THE_USDT','X_USDT','ZKX_USDT'],
  20240831: ['ANT_USDT','BTF_BTC','BTF_USDT','COOK_ETH','COOK_USDT','CRPT_ETH','CRPT_USDT','DOCK_ETH','DOCK_USDT','FORM_ETH','FORM_USDT','FOUR_USDT','FUEL_USDT','HMTT_USDT','KLAY3L_USDT','KLAY3S_USDT','KLAY_USDT','MATIC_ETH','MATIC_TRY','MATIC_USDC','MATIC_USDT','NII_USDT','NMT_ETH','NMT_USDT','SCLP_ETH','SCLP_USDT','SMILE_USDT','THE_USDT','X_USDT'],
  20240930: ['BBQ_USDT','BTF_BTC','COOK_ETH','COOK_USDT','DOCK_ETH','DOCK_USDT','FUEL_USDT','KLAY3L_USDT','KLAY3S_USDT','KLAY_USDT','SCLP_ETH','SCLP_USDT','SMILE_USDT','THE_USDT','X_USDT'],
  20241031: ['BTF_BTC','BTF_USDT','DOCK_ETH','DOCK_USDT','FUEL_ETH','FUEL_USDT','SCLP_ETH','SCLP_USDT','THE_USDT'],
  20241130: ['FUEL_USDT'],
};

/**
 * Whether gate filed this path under a month that is not its own.
 *
 * **The hourly books are not asked about.** Their stamp carries an hour, and that
 * one misfiling is the only copy of what it holds.
 */
export const gateMisfiled = (path: string): boolean => {
  const at = MISFILED.exec(path);

  if (! at || at[1] === at[2]) return false;

  return ! kept(path, at[2]!);
};

/**
 * Whether gate filed this USDT-settled file under its BTC-settled tree.
 *
 * **The BTC tree's own instruments are `*_USD`**; a `*_USDT` under
 * `futures_btc/` belongs elsewhere, and every one of them is a copy of something
 * filed properly or a fragment of it. Checked file by file against the archive
 * and the old complete catalog, 2026-10-01 — 1,754 files in four months:
 *
 * - `trades/202203`, 1,606: **spot weekly candles**, not trades, as first written
 *   on 2022-04-03 — a partial last week and a week from February. Every one has
 *   its original at `spot/candlesticks_7d/202203/`, republished complete in 2024.
 * - `trades/202203/TONC_USDT`: spot trades, byte for byte the size of
 *   `spot/deals/202203/TONC_USDT-202203.csv.gz`.
 * - `trades/202208`, 144: about five minutes of futures trades from 2022-08-05,
 *   every row inside the month's file in `futures_usdt/trades/`.
 * - `funding_updates` and `mark_prices` of `201911`, 4: the first minutes of
 *   2019-11-20 for EOS and ETH, missing from the properly filed month. Refused all
 *   the same: a month split across two files is a month this catalog treats as
 *   unpublished for those minutes, not one a consumer is asked to stitch together.
 *
 * Catalogued, they took the same canonical names as the files they copy — a
 * bucket key listed twice.
 */
export const gateWrongTree = (path: string): boolean => WRONG_TREE.test(path);

/** Whether this is one of the 324 the archive holds nowhere else. */
const kept = (path: string, month: string): boolean => {
  const day = DAY.exec(path);

  if (! day) return false;

  const symbols = KEPT[day[2]!];

  return symbols !== undefined && symbols.includes(day[1]!) && month === day[2]!.slice(0, 6);
};

/**
 * A path whose directory names a month and whose filename names another.
 *
 * Six digits or eight — a month or a day — and deliberately not ten, which is the
 * books hour.
 */
const MISFILED = /\/(\d{6})\/[^/]*?-(\d{6})(?:\d{2})?\.[a-z.]+$/;

/** A `*_USDT` file anywhere under the BTC-settled tree. */
const WRONG_TREE = /^futures_btc\/[^/]+\/\d{6}\/[^/]+_USDT-[^/]+$/;

/** The instrument and the day a daily filename carries. */
const DAY = /\/([^/]+)-(\d{8})\.[a-z.]+$/;
