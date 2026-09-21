import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export class Tokens {
  constructor(private key: string) {
    if (key.length < 32) throw new Error('TOKEN_SECRET must contain at least 32 characters');
  }
  addressId(address: string) {
    return createHmac('sha256', this.key).update(address.trim().toLowerCase()).digest('hex');
  }
  sign(id: string, purpose: string, expires: number) {
    const payload = Buffer.from(JSON.stringify({ id, purpose, expires })).toString('base64url');
    return payload + '.' + this.mac(payload);
  }
  verify(token: string, purpose: string, now: number): string {
    if (typeof token !== 'string' || token.length > 2000) throw new Error('Invalid link');
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !equal(signature, this.mac(payload)))
      throw new Error('Invalid link');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.purpose !== purpose || typeof data.id !== 'string' || data.expires < now)
      throw new Error('Link expired or invalid');
    return data.id;
  }
  private mac(value: string) {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export interface PushData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export function validatePush(p: PushData) {
  if (!p || typeof p.endpoint !== 'string' || p.endpoint.length > 2048)
    throw new Error('Invalid push subscription');
  const url = new URL(p.endpoint);
  // Public push gateways only: never make server-side requests to arbitrary client URLs.
  const hosts = [
    'fcm.googleapis.com',
    'updates.push.services.mozilla.com',
    'web.push.apple.com',
    'notify.windows.com',
  ];
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !hosts.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))
  )
    throw new Error('Unsupported push gateway');
  if (
    !p.keys ||
    !/^[\w-]{80,100}={0,2}$/.test(p.keys.p256dh) ||
    !/^[\w-]{20,30}={0,2}$/.test(p.keys.auth)
  )
    throw new Error('Invalid push keys');
}
