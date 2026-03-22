import Dockerode from 'dockerode';
import { selectFromList } from '../ui/prompts.js';

interface DiscoveryResult {
  host: string;
  port: number;
  url: string;
}

/**
 * Auto-discover a service from running Docker containers.
 * Looks for containers with the service name in image/name, extracts mapped port,
 * and returns connection details.
 *
 * If multiple instances are found, prompts user to select one.
 */
export async function discoverService(
  serviceName: 'mongodb' | 'rabbitmq' | 'bouncer',
  urlBuilder?: (host: string, port: number) => string,
  internalPort?: number,
): Promise<DiscoveryResult | null> {
  try {
    const docker = new Dockerode();
    const containers = await docker.listContainers({ all: false });

    // Find matching containers
    const matches = containers.filter(c => {
      const imageName = (c.Image || '').toLowerCase();
      const containerName = (c.Names?.[0] || '').toLowerCase();
      return imageName.includes(serviceName) || containerName.includes(serviceName);
    });

    if (matches.length === 0) {
      return null;
    }

    // Extract port for each match
    const options = matches
      .map(c => {
        const name = (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, '');
        // Find the mapped public port — prefer the specified internal port if given
        const portBinding = internalPort
          ? c.Ports?.find(p => p.PrivatePort === internalPort)
          : c.Ports?.[0];
        if (! portBinding?.PublicPort) return null;
        return {
          name,
          host: 'localhost',
          port: portBinding.PublicPort,
        };
      })
      .filter((opt): opt is { name: string; host: string; port: number } => opt !== null);

    if (options.length === 0) {
      return null;
    }

    // If only one, use it directly
    if (options.length === 1) {
      const { host, port } = options[0];
      return {
        host,
        port,
        url: urlBuilder ? urlBuilder(host, port) : `${host}:${port}`,
      };
    }

    // Multiple instances — prompt user
    const choice = await selectFromList(
      options.map(opt => ({
        name: `${opt.name} (${opt.host}:${opt.port})`,
        value: opt,
      })),
      `Multiple ${serviceName} instances found. Select one:`,
    );

    if (! choice) return null;

    return {
      host: choice.host,
      port: choice.port,
      url: urlBuilder ? urlBuilder(choice.host, choice.port) : `${choice.host}:${choice.port}`,
    };
  } catch (err) {
    // Docker not available or error — return null to fall back to env vars
    return null;
  }
}
