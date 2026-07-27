/**
 * Symbols whose `futures_usdt/trades/202107/` file is **not futures data**.
 *
 * For one month, gate served the *spot* file at the futures URL for these 85
 * symbols. It is not a transport fault: the bytes match the spot file for the
 * same symbol and month, they carry spot's 5-column shape where every other
 * month of gate futures has 4, and re-fetching returns the same md5. Gate
 * publishes this.
 *
 * The damage it does is silent rather than loud. Read with the futures map the
 * file "works": the first four columns line up, spot's unsigned size lands where
 * the signed futures size belongs, and every trade reads as a **buy** because
 * the side is a sign that is never negative. 65 partitions were built that way
 * before anyone noticed, and the only reason it surfaced was a truncated
 * timestamp in an unrelated check.
 *
 * A full scan of all 16,898 gate futures trade files found it in 2021-07 alone.
 * For 84 of the 85 the perp market did not exist yet, so nothing real is lost;
 * `SUN_USDT` is the one genuine gap and is listed in `docs/venues/GATE.md` as a
 * REST backfill item.
 *
 * **This list is why the exclusion lives in code.** The files were deleted once,
 * and that cleanup survived only because trucker's ledgers happened not to be
 * cleared — the moment they are, the walk re-fetches all 85 and puts the garbage
 * back. A ledger is disposable by design; a rule about what must never be
 * fetched is not.
 */
export const GATE_202107_SPOT_AT_FUTURES_URL: readonly string[] = [
  'ACH_USDT',
  'AKT_USDT',
  'API3_USDT',
  'ARPA_USDT',
  'AUCTION_USDT',
  'AVA_USDT',
  'BAC_USDT',
  'BANK_USDT',
  'BAS_USDT',
  'BEL_USDT',
  'CELR_USDT',
  'CORE_USDT',
  'COTI_USDT',
  'CRO_USDT',
  'CTK_USDT',
  'CTSI_USDT',
  'CVX_USDT',
  'DATA_USDT',
  'DEXE_USDT',
  'DIA_USDT',
  'DIS_USDT',
  'DUSK_USDT',
  'ENJ_USDT',
  'EWT_USDT',
  'FET_USDT',
  'FIDA_USDT',
  'FLUX_USDT',
  'FORM_USDT',
  'FRAX_USDT',
  'GAS_USDT',
  'GLM_USDT',
  'GS_USDT',
  'GT_USDT',
  'HNT_USDT',
  'ICX_USDT',
  'ILV_USDT',
  'INJ_USDT',
  'IOST_USDT',
  'IOTA_USDT',
  'IOTX_USDT',
  'JASMY_USDT',
  'KNC_USDT',
  'LAYER_USDT',
  'LIT_USDT',
  'LSK_USDT',
  'MANA_USDT',
  'METIS_USDT',
  'MET_USDT',
  'NEO_USDT',
  'NMR_USDT',
  'ONE_USDT',
  'ONG_USDT',
  'OPEN_USDT',
  'PHA_USDT',
  'PI_USDT',
  'POWR_USDT',
  'PROM_USDT',
  'PSG_USDT',
  'PUNDIX_USDT',
  'QNT_USDT',
  'RAY_USDT',
  'RED_USDT',
  'RIF_USDT',
  'RLC_USDT',
  'RSR_USDT',
  'RUNE_USDT',
  'RVN_USDT',
  'SAND_USDT',
  'SCRT_USDT',
  'SFP_USDT',
  'SNOW_USDT',
  'STAR_USDT',
  'STEEM_USDT',
  'STX_USDT',
  'SUN_USDT',
  'TRB_USDT',
  'TWT_USDT',
  'UMA_USDT',
  'USDC_USDT',
  'VELO_USDT',
  'VRT_USDT',
  'VTHO_USDT',
  'WOO_USDT',
  'YGG_USDT',
  'ZRX_USDT',
];
