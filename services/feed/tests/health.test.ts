import { describe, it, expect } from 'vitest';
import { determineHealth } from '../src/health';
import type { HealthState } from '../src/types';

describe('Health checks', () => {
  describe('determineHealth', () => {
    const baseTime = 1000000000;

    it('should report healthy when realtime WS connected and messages are recent', () => {
      const state: HealthState = {
        realtimeConnected: true,
        platformConnected: false,
        lastMessageTime: baseTime - 5000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.body.status).toBe('healthy');
    });

    it('should report healthy when platform WS connected and messages are recent', () => {
      const state: HealthState = {
        realtimeConnected: false,
        platformConnected: true,
        lastMessageTime: baseTime - 5000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.body.status).toBe('healthy');
    });

    it('should report healthy when both connections active and messages recent', () => {
      const state: HealthState = {
        realtimeConnected: true,
        platformConnected: true,
        lastMessageTime: baseTime - 5000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('should report unhealthy when neither connection is active', () => {
      const state: HealthState = {
        realtimeConnected: false,
        platformConnected: false,
        lastMessageTime: baseTime - 1000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.body.status).toBe('unhealthy');
    });

    it('should report unhealthy when messages are stale (> 30s)', () => {
      const state: HealthState = {
        realtimeConnected: true,
        platformConnected: false,
        lastMessageTime: baseTime - 35000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.body.lastMessage).toBe(35000);
    });

    it('should handle clock skew gracefully (message in future)', () => {
      const state: HealthState = {
        realtimeConnected: true,
        platformConnected: false,
        lastMessageTime: baseTime + 5000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(true);
    });

    it('should report unhealthy when both disconnected and stale', () => {
      const state: HealthState = {
        realtimeConnected: false,
        platformConnected: false,
        lastMessageTime: baseTime - 60000,
      };

      const result = determineHealth(state, baseTime);

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBe(503);
    });
  });
});
