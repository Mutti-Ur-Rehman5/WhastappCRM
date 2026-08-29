import { redisConnectionOptions } from '../config/redis.js';

export function bullmqConnection() {
  return redisConnectionOptions();
}
