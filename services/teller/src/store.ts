/**
 * Registry-backed accessors — avoid prop drilling for providers, config, and state
 * in boundary modules (db/, publisher/, fills/consumer, rest/routes).
 *
 * Pure function modules (orders/, positions/, margin/, fills/engine) receive data
 * as plain arguments and never call these functions.
 */
import { registry, SK_STATE, SK_CONFIG, SK_PROVIDERS } from '@devvir/service-kit';
import type { Broker } from '@devvir/service-kit';
import type { MongoClient } from 'mongodb';
import type { State, Config } from './types';

export const getState  = (): State  => registry.get('teller', SK_STATE) as unknown as State;
export const getConfig = (): Config => registry.get('teller', SK_CONFIG) as unknown as Config;

export const getMongo  = (): MongoClient => registry.get('teller', SK_PROVIDERS).get('mongodb') as MongoClient;
export const getBroker = (): Broker     => registry.get('teller', SK_PROVIDERS).get('rabbitmq') as Broker;
