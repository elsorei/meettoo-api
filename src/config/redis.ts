import { createClient, RedisClientType } from 'redis';
import { env } from './env';

let client: RedisClientType;

export async function getRedis(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url: env().REDIS_URL });
    client.on('error', (err) => console.error('Redis error:', err));
    await client.connect();
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
  }
}
