/**
 * Service availability checking utilities.
 * Useful for conditionally skipping integration tests when external services aren't running.
 */

/**
 * Check if one or more services are available by attempting connection.
 * @param services - Array of service configs with name and URL
 * @param timeout - Connection timeout in milliseconds (default: 3000)
 * @returns true if all services are available, false otherwise
 */
export async function areServicesAvailable(
  services: Array<{ name: string; url: string }>,
  timeout = 3000,
): Promise<boolean> {
  try {
    await Promise.all(
      services.map((service) =>
        Promise.race([
          checkServiceConnection(service.url),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`${service.name} timeout`)), timeout),
          ),
        ]),
      ),
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `\n⚠️  Services not available: ${message}\n`,
      `Available services: ${services.map((s) => s.name).join(', ')}\n`,
      'Environment variables:',
      services.map((s) => `  ${s.name}: ${s.url}`).join('\n'),
    );
    return false;
  }
}

/**
 * Check connection to a service URL.
 * Supports both HTTP and AMQP URLs.
 */
async function checkServiceConnection(url: string): Promise<void> {
  try {
    if (url.startsWith('amqp://') || url.startsWith('amqps://')) {
      // For RabbitMQ: dynamic import to avoid circular dependencies
      const { keepAlive } = await import('@devvir/rabbitmq');
      const broker = await keepAlive(url);
      await broker.disconnect();
    } else if (url.startsWith('mongodb://') || url.startsWith('mongodb+srv://')) {
      // For MongoDB: dynamic import
      const { MongoClient } = await import('mongodb');
      const client = new MongoClient(url);
      await client.connect();
      await client.close();
    } else {
      // For HTTP/HTTPS: try a simple fetch
      const response = await fetch(url);
      if (! response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to ${url}: ${message}`);
  }
}
