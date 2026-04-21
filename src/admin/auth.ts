import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';

const COOKIE_NAME = 'admin_session';

function getSessionSecret(): string {
  return `${config.ADMIN_PASSWORD}:${config.AI_MODEL}:${config.NAPCAT_WS_URL}`;
}

function signPayload(payload: string): string {
  return createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
}

export function createSessionToken(nowSeconds: number): string {
  const expiresAt = nowSeconds + config.ADMIN_SESSION_TTL_SECONDS;
  const payload = `${expiresAt}`;
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string | undefined, nowSeconds: number): boolean {
  if (!token) {
    return false;
  }

  const [expiresRaw, signature] = token.split('.');
  if (!expiresRaw || !signature || !/^\d+$/.test(expiresRaw)) {
    return false;
  }

  const expected = signPayload(expiresRaw);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return false;
  }

  return Number(expiresRaw) > nowSeconds;
}

export function parseCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const [rawName, ...rest] = pair.trim().split('=');
    if (rawName === name) {
      return decodeURIComponent(rest.join('='));
    }
  }

  return undefined;
}

export function buildSessionCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.ADMIN_SESSION_TTL_SECONDS}`;
}

export function buildClearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export function getSessionCookieName(): string {
  return COOKIE_NAME;
}
