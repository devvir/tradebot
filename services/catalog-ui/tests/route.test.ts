import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkTo, readRoute } from '../web/App';
import type { Route } from '../web/App';

/** The page's address: what a hash names, and the hash each view is linked by. */

const at = { hash: '' };

beforeEach(() => { at.hash = ''; vi.stubGlobal('location', at); });
afterEach(() => { vi.unstubAllGlobals(); });

/** The route a hash names, read the way the page reads `location.hash`. */
const reading = (hash: string): Route => {
  at.hash = hash;

  return readRoute();
};

describe('readRoute', () => {
  it.each(['', '#', '#surveys', '#nowhere', '#surveys/deeper'])('reads %j as the surveys view', hash => {
    expect(reading(hash)).toEqual({ section: 'surveys' });
  });

  it('reads the contents at each depth, with or without a lens', () => {
    expect(reading('#contents')).toEqual({ section: 'contents' });
    expect(reading('#contents/binance')).toEqual({ section: 'contents', venue: 'binance' });
    expect(reading('#contents/binance/spot?lens=mine'))
      .toEqual({ section: 'contents', venue: 'binance', market: 'spot', lens: 'mine' });
  });

  it('reads the lenses section, with or without a lens', () => {
    expect(reading('#lenses')).toEqual({ section: 'lenses' });
    expect(reading('#lenses/mine')).toEqual({ section: 'lenses', lens: 'mine' });
  });

  it('keeps a segment whose encoding is malformed as it was written', () => {
    expect(reading('#contents/%E0%A4%A/spot')).toEqual({ section: 'contents', venue: '%E0%A4%A', market: 'spot' });
  });
});

describe('linkTo', () => {
  it('links surveys and the lenses section at the depth they have', () => {
    expect(linkTo({ section: 'surveys', venue: 'binance' })).toBe('#surveys');
    expect(linkTo({ section: 'lenses' })).toBe('#lenses');
    expect(linkTo({ section: 'lenses', lens: 'mine' })).toBe('#lenses/mine');
  });

  it('takes a link with no section for the contents, and a market only below a venue', () => {
    expect(linkTo({})).toBe('#contents');
    expect(linkTo({ market: 'spot' })).toBe('#contents');
    expect(linkTo({ venue: 'binance', market: 'spot' })).toBe('#contents/binance/spot');
  });

  it('keeps the lens of the contents being looked at, unless the link names one or none', () => {
    at.hash = '#contents/binance?lens=mine';

    expect(linkTo({ venue: 'binance', market: 'spot' })).toBe('#contents/binance/spot?lens=mine');
    expect(linkTo({ venue: 'okx', lens: 'theirs' })).toBe('#contents/okx?lens=theirs');
    expect(linkTo({ venue: 'okx', lens: undefined })).toBe('#contents/okx');
  });

  it('does not carry the lens being edited into the contents', () => {
    at.hash = '#lenses/mine';

    expect(linkTo({ venue: 'binance' })).toBe('#contents/binance');
  });

  it.each([
    ['a slash',   { venue: 'a/b', market: 'c/d', lens: 'e/f' }],
    ['a ?',       { venue: 'a?b', market: 'c?d', lens: 'e?f' }],
    ['a %',       { venue: '50%', market: '%2F', lens: '%zz' }],
    ['a # and &', { venue: 'a#b', market: 'c&d', lens: 'e&lens=f' }],
    ['a + and a space', { venue: 'a+b', market: 'c d', lens: 'e+ f' }],
  ])('reads back what it links, with %s in every part', (_, parts) => {
    const contents: Route = { section: 'contents', ...parts };
    const lenses:   Route = { section: 'lenses', lens: parts.lens };

    expect(reading(linkTo(contents))).toEqual(contents);
    expect(reading(linkTo(lenses))).toEqual(lenses);
  });
});
