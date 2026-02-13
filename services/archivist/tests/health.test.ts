import { HealthState } from '../src/health';

describe('Health types', () => {
  describe('HealthState interface', () => {
    it('should define health state structure', () => {
      const state: HealthState = {
        mongoConnected: true,
        mqConnected: true,
        messagesProcessed: 100,
        lastProcessedTime: Date.now()
      };

      expect(state.mongoConnected).toBe(true);
      expect(state.mqConnected).toBe(true);
      expect(state.messagesProcessed).toBe(100);
      expect(typeof state.lastProcessedTime).toBe('number');
    });

    it('should handle unhealthy state', () => {
      const state: HealthState = {
        mongoConnected: false,
        mqConnected: true,
        messagesProcessed: 0,
        lastProcessedTime: 0
      };

      expect(state.mongoConnected).toBe(false);
      expect(state.mqConnected).toBe(true);
    });
  });
});


