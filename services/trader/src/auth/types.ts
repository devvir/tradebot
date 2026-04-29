/**
 * Auth module types
 */

export interface ApiCredentials {
  apiKey:    string;
  apiSecret: string;
}

export interface SignedRestHeaders {
  'api-key':       string;
  'api-expires':   string;
  'api-signature': string;
}

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'DELETE';
