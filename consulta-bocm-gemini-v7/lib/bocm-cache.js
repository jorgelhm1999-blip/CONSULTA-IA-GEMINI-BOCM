import { getCache } from '@vercel/functions';
import { createHash } from 'node:crypto';

const cache = getCache({ namespace: 'bocmi-v3' });
const inFlight = new Map();
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Cache failures must not turn into source failures. Bound latency independently.
async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('cache timeout')), 1200);
    })]);
  } catch {
    console.warn('bocmi_cache_unavailable');
    return null;
  } finally { clearTimeout(timer); }
}
export const cacheGet = key => bounded(() => cache.get(key));
export const cacheSet = (key, value, ttl = 86400) => bounded(() => cache.set(key, value, { ttl }));
export const cacheDelete = key => bounded(() => cache.delete(key));
export async function singleFlight(key, operation) {
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = operation();
  inFlight.set(key, pending);
  try { return await pending; } finally { inFlight.delete(key); }
}
