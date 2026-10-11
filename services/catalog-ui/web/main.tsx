import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, MantineProvider, createTheme } from '@mantine/core';
import type { MantineTheme } from '@mantine/core';
import { App } from './App';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/400-italic.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/400-italic.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-mono/700.css';
import '@mantine/core/styles.css';
import './style.css';

/**
 * **Dark, in IBM Plex: Sans for the page, Mono for its data.** The interface —
 * labels, buttons, tabs, headings, prose — reads in Sans; what is compared down
 * a column or copied out — table cells, keys, addresses — in Mono, where every
 * character has the same width and a column of identifiers lines up. Both are
 * bundled with the page rather than left to whatever the viewer's system has,
 * so they read the same everywhere and need nothing from the network; the
 * system's own are what is left if they fail.
 *
 * **The brand's colours, from its mark** (`public/favicon.svg`), each spread
 * into the ten shades Mantine works with, the mark's own at the shade used:
 *
 * - `sky` (#38BDF8) — the catalog's badge, and so its primary colour: what the
 *   page offers to do.
 * - `signal` (#F5B83D) — Tradebot's rising bars: the name, and nothing else yet.
 * - `rise` (#2EBD85) — the mark's green: what is let in, what went well.
 */
const SANS = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const theme = createTheme({
  fontFamily:          SANS,
  fontFamilyMonospace: MONO,
  headings:            { fontFamily: SANS },
  defaultRadius:       'sm',
  colors: {
    /**
     * **Mantine's dark greys, leaned towards the mark's ink.** Shade 0 is text,
     * 2 dimmed text, 4 borders, 5 a hover, 6 a field or card, 7 the page, and
     * 8–9 below it. Each keeps its place in the scale, so every component lands
     * where it would on Mantine's own — darker, and blue-black rather than grey.
     * Text on the page and in its fields keeps at least WCAG AA's 4.5:1, the
     * placeholders (shade 3) included: theirs say things like "All" and "Open".
     */
    dark:   ['#d5dce4', '#b4bdc8', '#8a95a3', '#7f8a99', '#323b48', '#252d38', '#18202a', '#0e131a', '#0b0f14', '#070a0e'],
    sky:    ['#f0f9ff', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985', '#0c4a6e'],
    signal: ['#fff8e6', '#feefc7', '#fde08f', '#fbd062', '#f9c449', '#f5b83d', '#dc9f27', '#b47f1c', '#8a6015', '#5f420e'],
    rise:   ['#e6fbf2', '#c3f3df', '#93e8c6', '#5fdcab', '#3fcf96', '#2ebd85', '#21a070', '#1a7f59', '#135f43', '#0c402d'],
  },
  primaryColor:        'sky',
  primaryShade:        { light: 6, dark: 4 },
  components: {
    /**
     * **A filled button's text is whichever of white and the mark's ink reads
     * better on its fill** — the higher contrast of the two, as WCAG measures it.
     * The brand's fills are light (white on its green is 2.4:1, where AA asks
     * 4.5:1) and Mantine's own are mostly dark, so neither colour alone serves.
     */
    Button: Button.extend({
      vars: (theme, props) => {
        const fill = (props.variant ?? 'filled') === 'filled' ? fillOf(theme, props.color) : null;

        return { root: fill ? { '--button-color': readableOn(fill) } : {} };
      },
    }),
  },
});

/** The mark's ink: its darkest colour, and the text on its lightest fills. */
const INK = '#0b0f14';

/**
 * The colour a filled control is painted with: its own colour at the shade the
 * theme fills with, or the colour given outright. Null where it cannot be known.
 *
 * The dark shade only: the page has no light scheme.
 */
const fillOf = (theme: MantineTheme, color: string | undefined): string | null => {
  const named = color ?? theme.primaryColor;

  if (named.startsWith('#')) return named;

  const [name, given] = named.split('.');
  const shade = given !== undefined ? Number(given)
    : typeof theme.primaryShade === 'object' ? theme.primaryShade.dark : theme.primaryShade;

  return theme.colors[name!]?.[shade] ?? null;
};

/** White or the ink, whichever stands out more against this colour. */
const readableOn = (fill: string): string =>
  (contrast(fill, '#ffffff') >= contrast(fill, INK) ? '#ffffff' : INK);

/** WCAG's contrast ratio of two `#rrggbb` colours, 1 to 21. */
const contrast = (one: string, other: string): number => {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a) as [number, number];

  return (light + 0.05) / (dark + 0.05);
};

/** WCAG's relative luminance of a `#rrggbb` colour. */
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;

    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <App />
    </MantineProvider>
  </StrictMode>,
);
