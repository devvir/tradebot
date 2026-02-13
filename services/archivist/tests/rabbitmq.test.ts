import { connectRabbitMQ } from '../src/rabbitmq';

jest.mock('amqplib');

describe('RabbitMQ connection', () => {
  let mockConnection: any;
  let mockChannel: any;

  beforeEach(() => {
    mockChannel = {
      close: jest.fn().mockResolvedValue(undefined)
    };

    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
      close: jest.fn().mockResolvedValue(undefined),
      on: jest.fn()
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('connectRabbitMQ', () => {
    it('should return a channel and connection object', async () => {
      const rabbitmq = require('amqplib');
      rabbitmq.connect = jest.fn().mockResolvedValue(mockConnection);

      const result = await connectRabbitMQ('amqp://guest:guest@localhost:5672');

      expect(result).toHaveProperty('channel');
      expect(result).toHaveProperty('connection');
    });

    it('should handle connection URL', async () => {
      const rabbitmq = require('amqplib');
      const url = 'amqp://test:pass@rabbitmq:5672';
      rabbitmq.connect = jest.fn().mockResolvedValue(mockConnection);

      const result = await connectRabbitMQ(url);

      expect(rabbitmq.connect).toHaveBeenCalledWith(url);
      expect(result.channel).toBeDefined();
    });
  });
});
