export interface ContainerRow {
  project: string;
  id: string;
  name: string;
  status: string;
  health: string;
  uptime: string;
  cpu: string;
  mem: string;
  restarts: string;
  lastLog: string;
}

export interface QueueRow {
  instance: string;
  name: string;
  vhost: string;
  ready: number;
  unacked: number;
  total: number;
  consumers: number;
  publishRate: string;
  deliverRate: string;
  state: string;
}

export interface RabbitInstance {
  name: string;
  project: string;
  mgmtUrl: string;
  auth: { username: string; password: string };
}
