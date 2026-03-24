import Dockerode from 'dockerode';
import axios from 'axios';
import { getEnv } from '../../shared/utils/env';
import type { RabbitInstance, QueueRow } from './types';

/**
 * Discover running RabbitMQ containers and extract their host-mapped
 * management port (container port 15672).
 */
export async function discoverRabbitInstances(docker: Dockerode): Promise<RabbitInstance[]> {
  const containers = await docker.listContainers({ all: false });
  const rabbitUser = getEnv('QUEUE_USER', 'guest')!;
  const rabbitPass = getEnv('QUEUE_PASS', 'guest')!;

  const instances: RabbitInstance[] = [];

  for (const c of containers) {
    const image = (c.Image || '').toLowerCase();
    if (! image.includes('rabbitmq')) continue;

    const project = c.Labels?.['com.docker.compose.project'] || '(standalone)';
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');

    const mgmtBinding = (c.Ports || []).find(
      (p: any) => p.PrivatePort === 15672 && p.PublicPort,
    );

    if (! mgmtBinding) continue;

    instances.push({
      name,
      project,
      mgmtUrl: `http://localhost:${mgmtBinding.PublicPort}`,
      auth: { username: rabbitUser, password: rabbitPass },
    });
  }

  return instances;
}

export async function fetchQueueRows(instance: RabbitInstance): Promise<QueueRow[]> {
  const res = await axios.get(`${instance.mgmtUrl}/api/queues`, {
    auth: instance.auth,
    timeout: 4000,
  });

  return (res.data as any[]).map((q) => ({
    instance: instance.name,
    name: q.name,
    vhost: q.vhost,
    ready: q.messages_ready ?? 0,
    unacked: q.messages_unacknowledged ?? 0,
    total: q.messages ?? 0,
    consumers: q.consumers ?? 0,
    publishRate: `${(q.message_stats?.publish_details?.rate ?? 0).toFixed(1)}/s`,
    deliverRate: `${(q.message_stats?.deliver_get_details?.rate ?? q.message_stats?.deliver_details?.rate ?? 0).toFixed(1)}/s`,
    state: q.state ?? 'unknown',
  }));
}
