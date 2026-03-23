export class MockedService {
  config(): unknown {
    return {
      dataUrl: 'http://test-data',
    };
  }

  state(_key: string): unknown {
    return {};
  }

  emit(_event: string): void {}

  on(_event: string, _handler: unknown): void {}
}
