import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'cookies',
      'cookies[*].value',
      'sessionData.cookies',
      'sessionData.cookies[*].value',
    ],
    censor: '[REDACTED]',
  },
});

export const createChildLogger = (context: Record<string, unknown>): pino.Logger => {
  return logger.child(context);
};
