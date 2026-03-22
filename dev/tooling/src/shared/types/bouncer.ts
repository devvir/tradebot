export interface BouncerAccount {
  id:     string;
  type:   'live' | 'testnet' | 'replay';
  apiKey: string;
}
