import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { App } from './App';
import '@mantine/core/styles.css';
import './style.css';

/**
 * **Dark, and monospace throughout.** This is a tool for reading dense tables of
 * identifiers, dates and counts — a proportional font makes columns of symbols
 * unscannable, and every figure on the page is meant to be compared with the one
 * above it.
 */
const theme = createTheme({
  fontFamily:          'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  headings:            { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  defaultRadius:       'sm',
  primaryColor:        'blue',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <App />
    </MantineProvider>
  </StrictMode>,
);
