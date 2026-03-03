import { keepAlive } from '@devvir/rabbitmq';
import type { Broker } from '@devvir/rabbitmq';
import type { Config } from './types';

export const connect = async (config: Config): Promise<Broker> => {
  const { rabbitmqUrl, topology } = config;

  const broker = await keepAlive(rabbitmqUrl);

  return broker.declares(topology);
};
