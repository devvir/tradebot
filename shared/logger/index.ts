import pino from 'pino';

// pino uses JSON.stringify internally; BigInt values cause it to silently drop
// the entire merging object and only output the string message.
// This makes BigInt serialize as a string, preserving log output.
(BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
  return this.toString();
};

const isDev = ['local', 'dev', 'development'].includes(process.env.NODE_ENV || '');

const transport = isDev
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        singleLine: false,
      },
    })
  : undefined;

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
  },
  transport
);

export default logger;
