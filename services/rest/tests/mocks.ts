export class MockedService {
  private dataUrl: string;

  constructor(dataUrl: string) {
    this.dataUrl = dataUrl;
  }

  config(): unknown {
    return {
      dataUrl: this.dataUrl,
    };
  }

  state(_key: string): unknown {
    return {};
  }

  emit(_event: string): void {}

  on(_event: string, _handler: unknown): void {}
}
