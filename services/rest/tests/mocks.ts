export class MockedService {
  config(key: string): unknown {
    const configs: Record<string, unknown> = {
      httpPort: 3001,
      snapshotsUrl: 'http://snapshots:3001',
    };
    return configs[key];
  }

  state(key: string): unknown {
    return {};
  }

  emit(event: string): void {
    // noop
  }

  on(event: string, handler: unknown): void {
    // noop
  }
}
