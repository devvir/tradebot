import inquirer from 'inquirer';
import { info } from './logger.js';

interface ToolOption {
  id: string;
  name: string;
  description: string;
}

interface SelectableItem {
  name: string | undefined;
  account?: string;
  [key: string]: any;
}

export async function selectTool(tools: ToolOption[]): Promise<string> {
  const choices = tools.map(tool => ({
    name: `${tool.name} - ${tool.description}`,
    value: tool.id,
    short: tool.name,
  }));

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'tool',
      message: 'Select a tool:',
      choices,
      pageSize: 15,
    },
  ]);

  return answer.tool;
}

export async function confirm(message: string): Promise<boolean> {
  const answer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message,
      default: false,
    },
  ]);

  return answer.confirmed;
}

/** Y/n/a prompt. Returns 'yes', 'no', or 'all'. Default answer is Y. */
export async function confirmYNA(message: string): Promise<'yes' | 'no' | 'all'> {
  const answer = await inquirer.prompt([
    {
      type:    'input',
      name:    'choice',
      message: `${message} [Y/n/a]`,
      default: '',
    },
  ]);

  const raw = (answer.choice as string).trim().toLowerCase();

  if (raw === 'n') { return 'no'; }
  if (raw === 'a') { return 'all'; }

  return 'yes';
}

export async function input(message: string, defaultValue: string | null = null): Promise<string> {
  const answer = await inquirer.prompt({
    type: 'input',
    name: 'value',
    message,
    default: defaultValue ?? undefined,
  });

  return answer.value;
}

export async function password(message: string): Promise<string> {
  const answer = await inquirer.prompt([
    {
      type: 'password',
      name: 'value',
      message,
      mask: '•',
    },
  ]);

  return answer.value;
}

export async function multiSelect(message: string, choices: string[]): Promise<string[]> {
  const answer = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'values',
      message,
      choices,
      pageSize: 15,
    },
  ]);

  return answer.values;
}

export async function selectAccount<T extends Partial<SelectableItem>>(
  accounts: T[],
  label: string = 'Select account:'
): Promise<T | null> {
  if (accounts.length === 0) {
    info('No accounts available');
    return null;
  }

  const choices = accounts.map(acc => ({
    name: (acc.name || acc.account || String(acc)) as string,
    value: acc,
  }));

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'account',
      message: label,
      choices,
      pageSize: 10,
    },
  ]);

  return answer.account as T;
}

export async function selectFromList<T>(
  choices: Array<{ name: string; value: T }>,
  message: string = 'Select an option:',
): Promise<T | null> {
  if (choices.length === 0) {
    info('No options available');
    return null;
  }

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'selected',
      message,
      choices,
      pageSize: 10,
    },
  ]);

  return answer.selected as T;
}
