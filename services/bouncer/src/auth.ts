import { createHmac } from 'node:crypto';

export function wsSign(apiSecret: string, expires: number): string {
  return createHmac('sha256', apiSecret)
    .update('GET/realtime' + expires)
    .digest('hex');
}

export function restSign(
  apiSecret: string,
  verb:      string,
  path:      string,
  expires:   number,
  body:      string,
): string {
  return createHmac('sha256', apiSecret)
    .update(verb + path + expires + body)
    .digest('hex');
}
