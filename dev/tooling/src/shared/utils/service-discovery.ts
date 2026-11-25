import Dockerode from 'dockerode';
import { selectFromList } from '../ui/prompts';

export interface DiscoveryResult {
  /** The container's name. */
  name: string;
  host: string;
  /** The host port the primary container port is published on. */
  port: number;
  url: string;
  /** Every published binding of the container: container port → host port. */
  ports: Record<number, number>;
}

interface Candidate {
  name: string;
  host: string;
  port: number;
  ports: Record<number, number>;
}

/**
 * Auto-discover a service from running Docker containers.
 * Looks for containers with the service name in image/name and returns the host port its primary
 * container port is published on, with the container's other published bindings.
 *
 * The primary port is `internalPort` when given, otherwise the first published binding. A
 * container that does not publish it is skipped: an unpublished port is unreachable from the host.
 *
 * If multiple instances are found, prompts user to select one.
 */
export async function discoverService(
  serviceName: 'rabbitmq',
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
        const ports: Record<number, number> = {};

        for (const p of c.Ports ?? []) {
          if (p.PublicPort && ports[p.PrivatePort] === undefined) ports[p.PrivatePort] = p.PublicPort;
        }

        const port = internalPort !== undefined
          ? ports[internalPort]
          : c.Ports?.find(p => p.PublicPort)?.PublicPort;

        if (! port) return null;

        return { name, host: 'localhost', port, ports };
      })
      .filter((opt): opt is Candidate => opt !== null);

    if (options.length === 0) {
      return null;
    }

    // If only one, use it directly
    if (options.length === 1) {
      return toResult(options[0], urlBuilder);
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

    return toResult(choice, urlBuilder);
  } catch (err) {
    // Docker not available or error — return null to fall back to env vars
    return null;
  }
}

function toResult(
  candidate: Candidate,
  urlBuilder?: (host: string, port: number) => string,
): DiscoveryResult {
  const { host, port } = candidate;

  return {
    ...candidate,
    url: urlBuilder ? urlBuilder(host, port) : `${host}:${port}`,
  };
}
