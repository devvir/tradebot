// Cleanup env vars after each test
afterEach(() => {
  delete process.env.RABBITMQ_URL;
  delete process.env.PIPE_BINDINGS;
});
