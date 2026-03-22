import { C } from '../utils/colors';

export function info(message: string): void {
  console.log(`${C.cyan}ℹ${C.reset} ${message}`);
}

export function success(message: string): void {
  console.log(`${C.green}✓${C.reset} ${message}`);
}

export function warn(message: string): void {
  console.log(`${C.yellow}⚠${C.reset} ${message}`);
}

export function error(message: string): void {
  console.log(`${C.red}✗${C.reset} ${message}`);
}

export function debug(message: string): void {
  if (process.env.DEBUG) {
    console.log(`${C.dim}${message}${C.reset}`);
  }
}

export function section(title: string): void {
  console.log(`\n${C.bold}${C.cyan}${title}${C.reset}`);
}

export function heading(title: string): void {
  console.log(`\n${C.bold}${C.blue}═══ ${title} ═══${C.reset}`);
}

export function spacer(): void {
  console.log();
}

export function table(data: Record<string, any>[], columns: string[]): void {
  const colWidths: Record<string, number> = {};

  columns.forEach(col => {
    colWidths[col] = Math.max(
      col.length,
      ...data.map(row => String(row[col] ?? '').length)
    );
  });

  const header = columns
    .map(col => col.padEnd(colWidths[col]))
    .join(' │ ');

  console.log(header);
  console.log('─'.repeat(header.length));

  data.forEach(row => {
    const line = columns
      .map(col => String(row[col] ?? '').padEnd(colWidths[col]))
      .join(' │ ');

    console.log(line);
  });
}
