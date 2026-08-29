import Redis from 'ioredis';
import Redlock from 'redlock';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export function redisConnectionOptions() {
  const options = {
    host: env.redis.host,
    port: env.redis.port,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  if (env.redis.username) options.username = env.redis.username;
  if (env.redis.password) options.password = env.redis.password;
  if (env.redis.tls) options.tls = {};
  return options;
}

export const redis = new Redis(redisConnectionOptions());

redis.on('ready', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis client error', { err: err.message }));

export const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 200,
  automaticExtensionThreshold: 500,
});

export async function closeRedis() {
  await redis.quit();
  logger.info('Redis closed');
}