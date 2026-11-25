import inquirer from 'inquirer';
import { info } from './logger';

interface ToolOption {
  id: string;
  name: string;
  description: string;
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

export async function confirm(message: string, defaultAnswer = false): Promise<boolean> {
  const answer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message,
      default: defaultAnswer,
    },
  ]);

  return answer.confirmed;
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
