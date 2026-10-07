/**
 * Gate's misfiled files: a period written into another month's directory, or
 * under a tree that is not its own. Refused, apart from the few that exist
 * nowhere else — see `docs/venues/GATE.md`.
 */

/**
 * The misfiled klines with no correctly filed copy: a closed list, since nothing
 * in a path tells them from the duplicates.
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
 * Whether a path's directory and filename name different months. Hourly books are
 * not asked: that misfiling is the only copy.
 */
export const gateMisfiled = (path: string): boolean => {
  const at = MISFILED.exec(path);

  if (! at || at[1] === at[2]) return false;

  return ! kept(path, at[2]!);
};

/** Whether a file sits under the BTC-settled tree without being one of its `*_USD` instruments. */
export const gateWrongTree = (path: string): boolean => WRONG_TREE.test(path);

/** Whether this is one of the 324 the archive holds nowhere else. */
const kept = (path: string, month: string): boolean => {
  const day = DAY.exec(path);

  if (! day) return false;

  const symbols = KEPT[day[2]!];

  return symbols !== undefined && symbols.includes(day[1]!) && month === day[2]!.slice(0, 6);
};

/**
 * A directory naming one month and a filename another: six digits or eight, never
 * the ten of a books hour.
 */
const MISFILED = /\/(\d{6})\/[^/]*?-(\d{6})(?:\d{2})?\.[a-z.]+$/;

/** A file under the BTC-settled tree whose instrument is not a `*_USD`. */
const WRONG_TREE = /^futures_btc\/[^/]+\/\d{6}\/(?![^/]*_USD-)[^/]+$/;

/** The instrument and the day a daily filename carries. */
const DAY = /\/([^/]+)-(\d{8})\.[a-z.]+$/;
