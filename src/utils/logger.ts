import pino from 'pino';

/**
 * Creates a configured logger instance.
 * In production: JSON logs for structured logging
 * In development: Pretty-printed logs with colors
 */
const createLogger = () => {
  const isDevelopment = process.env.NODE_ENV !== 'production';

  return pino({
    level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
    transport: isDevelopment ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    } : undefined,
  });
};

/**
 * Global logger instance.
 * Use this throughout the application for structured logging.
 *
 * @example
 * import { logger } from '@/utils/logger';
 *
 * logger.info('Server started');
 * logger.error({ err }, 'Failed to connect');
 * logger.debug({ deviceId }, 'Processing device');
 */
export const logger = createLogger();
