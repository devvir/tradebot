import { determineHealth } from '../src/health';
import type { HealthState } from '../src/types';

describe('Health check logic', () => {
  describe('determineHealth', () => {
    const baseTime = 1000000000;

    it('should report healthy when connected and messages are recent', () => {
      const state: HealthState = {
        wsConnected: true,
        lastMessageTime: baseTime - 5000, // 5 seconds ago
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.body.status).toBe('healthy');
      expect(result.body.wsConnected).toBe(true);
      expect(result.body.lastMessage).toBe(5000);
    });

    it('should report unhealthy when not connected even with recent messages', () => {
      const state: HealthState = {
        wsConnected: false,
        lastMessageTime: baseTime - 1000, // 1 second ago
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.body.status).toBe('unhealthy');
      expect(result.body.wsConnected).toBe(false);
    });

    it('should report unhealthy when messages are stale (>30s)', () => {
      const state: HealthState = {
        wsConnected: true,
        lastMessageTime: baseTime - 35000, // 35 seconds ago
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.body.status).toBe('unhealthy');
      expect(result.body.lastMessage).toBe(35000);
    });

    it('should report healthy at exactly 29999ms staleness', () => {
      const state: HealthState = {
        wsConnected: true,
        lastMessageTime: baseTime - 29999,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('should report unhealthy at exactly 30000ms staleness', () => {
      const state: HealthState = {
        wsConnected: true,
        lastMessageTime: baseTime - 30000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBe(503);
    });

    it('should handle lastMessageTime in the future gracefully', () => {
      const state: HealthState = {
        wsConnected: true,
        lastMessageTime: baseTime + 5000, // 5 seconds in future (clock skew)
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(true); // negative staleness is < threshold
      expect(result.body.lastMessage).toBe(-5000);
    });

    it('should calculate staleness correctly for very old messages', () => {
      const state: HealthState = {
        wsConnected: true,
        lastMessageTime: baseTime - 3600000, // 1 hour ago
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(false);
      expect(result.body.lastMessage).toBe(3600000);
    });

    it('should handle both disconnected and stale', () => {
      const state: HealthState = {
        wsConnected: false,
        lastMessageTime: baseTime - 60000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.body.wsConnected).toBe(false);
      expect(result.body.lastMessage).toBe(60000);
    });
  });
});
