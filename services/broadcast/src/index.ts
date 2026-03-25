import SK from './service';
import type { RabbitMQ, Service } from '@devvir/service-kit';
import makeConnection from './websocket';
import { createMessageHandler } from './messages';
import type { State } from './types';

SK.run(async (service: Service) => {
  const state = service.state() as State;
  const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;

  broker.getExchange()!.setBackpressureHandler((paused) => {
    if (paused) { state.realtime?.pause(); state.platform?.pause(); }
    else        { state.realtime?.resume(); state.platform?.resume(); }
  });

  const onMessage = createMessageHandler(service, () => service.emit('message'));

  const connectors = makeConnection(service, onMessage);

  connectors.connectRealtime();
  connectors.connectPlatform();
});
