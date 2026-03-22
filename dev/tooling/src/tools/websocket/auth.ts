import { fetchBouncerAccounts, signWsAccount } from '../../shared/connections/bouncer';
import { selectAccount } from '../../shared/ui/prompts';
import { success } from '../../shared/ui/logger';
import type { BouncerAccount } from '../../shared/types/bouncer';

export async function resolveAccount(
  accountArg?: string,
  guest?: boolean,
): Promise<{ account?: BouncerAccount; key?: string; signature?: string; expires?: number }> {
  if (guest) {
    success('Connecting as guest');
    return {};
  }

  const accounts = await fetchBouncerAccounts();

  if (accounts.length === 0) {
    throw new Error('No accounts found in Bouncer');
  }

  let selected: BouncerAccount | undefined;

  if (accountArg) {
    selected = accounts.find(acc => acc.id === accountArg);
    if (! selected) throw new Error(`Account "${accountArg}" not found`);
  } else {
    const withDisplay = accounts.map(acc => ({ ...acc, name: `${acc.id} (${acc.type})` }));

    selected = await selectAccount(withDisplay) ?? undefined;
    if (! selected) throw new Error('No account selected');
  }

  success(`Using account: ${selected.id}`);

  const expires = Math.floor(Date.now() / 1000) + 60;
  const signed  = await signWsAccount(selected.id, expires);

  if (! signed) throw new Error(`Could not get auth signature for account "${selected.id}"`);

  return { account: selected, key: signed.apiKey, signature: signed.signature, expires: signed.expires };
}

export function generateAuthMessage(key: string, expires: number, signature: string): object {
  return { op: 'authKeyExpires', args: [key, expires, signature] };
}
