import fs from 'node:fs';
import { C } from '../utils/colors';

let debugStream: fs.WriteStream | null = null;

export function openDebugLog(filePath: string): void {
  debugStream = fs.createWriteStream(filePath, { flags: 'a' });
}

export function closeDebugLog(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (! debugStream) { resolve(); return; }

    debugStream.end((err?: Error | null) => {
      debugStream = null;
      if (err) reject(err); else resolve();
    });
  });
}

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
  if (process.env.LOG_LEVEL === 'debug') {
    console.log(`${C.dim}${message}${C.reset}`);
    debugStream?.write(message + '\n');
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
