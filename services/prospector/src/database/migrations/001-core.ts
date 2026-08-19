import { CATALOG_SCHEMA } from '../schema';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 0 → 1. The catalog: its shape, and the rows that are constants of it.
 *
 * **One baseline rather than the history that produced it.** What a catalog
 * needs is the shape, not the sequence of edits some earlier database took to
 * reach it — and replaying those from empty could only fail, since they rename
 * columns that are now born under their final names. `CATALOG_SCHEMA` is
 * `IF NOT EXISTS` throughout, so this is equally correct on a database that
 * already has the tables.
 *
 * **The venues ship with the shape because they are part of it.** Which venues
 * exist, where each one is and what prefix it is rooted at cannot be discovered
 * and cannot change without a release — a venue moving its host is a new version
 * of this service, exactly as a column is. Carrying the whole row here rather
 * than splitting the identity from the addresses keeps one unit of information
 * in one place, and fixes the ids for ever: they are assigned in this frozen
 * order, so no seed and no new adapter can renumber the ones already assigned,
 * and adapters read `base` and `root` off these rows instead of restating them.
 *
 * **The exclusions ship for the same reason.** They name specific files a venue
 * still serves and always will, so a catalog rebuilt without them catalogues the
 * same bad bytes again. Both classes are documented where they are listed below.
 *
 * **Shape always, rows on request.** A catalog without tables is not a catalog,
 * while a fixture putting three files in one wants to own the venue ids rather
 * than inherit eight it did not ask for — so the schema applies unconditionally
 * and the rows honour `seedData`.
 */
export const core: Migration = {
  name: 'core',

  sql: CATALOG_SCHEMA,

  run: (db: DatabaseSync, seedData: boolean) => {
    if (! seedData) return;

    db.exec(VENUES);
    db.exec(ZERO_BYTE_UPLOADS);
    db.exec(SPOT_AT_A_FUTURES_URL);
  },
};

// ── The shipped rows ──────────────────────────────────────────────────────────

const VENUES = `
    INSERT OR IGNORE INTO venue (name, host, base, root) VALUES
      ('binance', '',          'https://data.binance.vision',                              ''),
      ('bitget',  '',          'https://img.bitgetimg.com/online',                         ''),
      ('bybit',   'primary',   'https://s3.ap-southeast-1.amazonaws.com/public.bybit.com', ''),
      ('bybit',   'secondary', 'https://quote-saver.bycsi.com',                            'orderbook/'),
      ('gate',    '',          'https://download.gatedata.org',                            ''),
      ('htx',     '',          'https://huobi-service-data.s3.amazonaws.com',              ''),
      ('kucoin',  '',          'https://historical-data.kucoin.com',                       'data/'),
      ('okx',     '',          'https://static.okx.com',                                   'cdn/');`;

/**
 * Two files gate left in its bucket that are not data.
 *
 * **Both are zero bytes**, uploaded four minutes apart on 2021-08-11 — somebody
 * testing an upload against the live bucket and never clearing it. Neither has
 * an extension, a symbol, or a date.
 *
 * Named by exact path, which is why they are rows and not part of gate's
 * `accepts`: `accepts` describes shapes, and there is no shape to describe.
 */
const ZERO_BYTE_UPLOADS = `
    INSERT OR IGNORE INTO exclusion (venue_id, path, reason)
    SELECT id, path, 'zero-byte upload test left in the bucket, 2021-08-11'
      FROM venue, (
        SELECT 'futures_usdt/candlesticks_10s/202107/123' AS path
        UNION ALL
        SELECT 'futures_btc/mark_prices/202107/hello/123'
      )
     WHERE venue.name = 'gate';`;

/**
 * The 85 gate files that are **not** what their URL says.
 *
 * For 2021-07 alone, `futures_usdt/trades/` served the *spot* file for these
 * symbols: gate's own bytes rather than a transport fault — five columns where
 * every other month of gate futures has four, and re-fetching returns the same
 * md5. Read as futures the file "works", because spot's unsigned size lands
 * where the signed futures size belongs and every trade then reads as a buy.
 *
 * For 84 of the 85 the perp market had not launched, so nothing real is missing;
 * `SUN_USDT` is the one genuine gap, recorded in `docs/venues/GATE.md`.
 *
 * **A list, so it is rows**: there is no shape to describe, only these files in
 * that one month, and gate still serves the same bytes.
 */
const SPOT_AT_A_FUTURES_URL = `
    WITH bad(path) AS (
      VALUES
          ('futures_usdt/trades/202107/ACH_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/AKT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/API3_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/ARPA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/AUCTION_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/AVA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/BAC_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/BANK_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/BAS_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/BEL_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/CELR_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/CORE_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/COTI_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/CRO_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/CTK_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/CTSI_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/CVX_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/DATA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/DEXE_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/DIA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/DIS_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/DUSK_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/ENJ_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/EWT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/FET_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/FIDA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/FLUX_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/FORM_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/FRAX_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/GAS_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/GLM_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/GS_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/GT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/HNT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/ICX_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/ILV_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/INJ_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/IOST_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/IOTA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/IOTX_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/JASMY_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/KNC_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/LAYER_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/LIT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/LSK_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/MANA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/METIS_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/MET_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/NEO_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/NMR_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/ONE_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/ONG_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/OPEN_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/PHA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/PI_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/POWR_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/PROM_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/PSG_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/PUNDIX_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/QNT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/RAY_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/RED_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/RIF_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/RLC_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/RSR_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/RUNE_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/RVN_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/SAND_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/SCRT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/SFP_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/SNOW_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/STAR_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/STEEM_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/STX_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/SUN_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/TRB_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/TWT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/UMA_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/USDC_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/VELO_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/VRT_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/VTHO_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/WOO_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/YGG_USDT-202107.csv.gz'),
          ('futures_usdt/trades/202107/ZRX_USDT-202107.csv.gz')
    )
    INSERT OR IGNORE INTO exclusion (venue_id, path, reason)
    SELECT venue.id, bad.path, 'spot data served at the futures URL, 2021-07'
      FROM venue, bad
     WHERE venue.name = 'gate';`;
