import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import WebSocket from 'ws';
import type { Database } from '../../database/database.js';
import { conversations, deliveryOutbox } from '../../database/schema/index.js';
import {
  createTrustedRosterEvidence,
  createVerifiedChannelEvidence,
  type ChannelEvidence,
  type TrustedRosterEvidence,
} from '../../identity/trust.js';
import type { DeliveryResult } from '../../transactions/delivery-service.js';

const MAX_FRAME = 256 * 1024;
const MAX_TEXT = 32_000;
const MAX_TIMESTAMP_SECONDS = 8_640_000_000_000;
const ID = /^(?!local-cli:)[0-9]{1,32}$/;

type NormalizedOneBotEvent = {
  eventId: string;
  senderPlatformId: string;
  conversationPlatformId: string;
  conversationKind: 'private' | 'group';
  text: string;
  timestamp: string;
  participantPlatformIds: string[];
  participantsComplete: false;
};

type OneBotConfig = {
  enabled: boolean;
  url?: string;
  accessToken?: string;
  selfId?: string;
  characterId: string;
  database: Database;
  onInbound: (event: NormalizedOneBotEvent, evidence: ChannelEvidence) => void | Promise<void>;
  requestTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
};

type OneBotAdapter = {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendDelivery(deliveryId: string): Promise<DeliveryResult>;
  fetchCompleteRoster(groupId: string): Promise<{ memberIds: string[]; evidence: TrustedRosterEvidence }>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

type RawNumericId = { key: string; value: string };

function platformId(value: unknown): string | null {
  const id = typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
  return ID.test(id) ? id : null;
}

function timestampFromSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_SECONDS) {
    return null;
  }
  try {
    return new Date(value * 1000).toISOString();
  } catch {
    return null;
  }
}

export function normalizeOneBotEvent(value: unknown): NormalizedOneBotEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.post_type !== 'message' || !['private', 'group'].includes(String(event.message_type))) return null;

  const senderId = platformId(event.user_id);
  const eventId = platformId(event.message_id);
  const selfId = platformId(event.self_id);
  const groupId = event.message_type === 'group' ? platformId(event.group_id) : null;
  const timestamp = timestampFromSeconds(event.time);
  if (!senderId || !eventId || !selfId || !timestamp || (event.message_type === 'group' && !groupId)) return null;

  let text = '';
  if (typeof event.message === 'string') {
    text = event.message;
  } else if (Array.isArray(event.message)) {
    for (const part of event.message) {
      if (!part || typeof part !== 'object') return null;
      const segment = part as Record<string, unknown>;
      const data = segment.data as Record<string, unknown> | undefined;
      if (segment.type !== 'text' || typeof data?.text !== 'string') return null;
      text += data.text;
      if (text.length > MAX_TEXT) return null;
    }
  } else {
    return null;
  }
  if (!text.trim() || text.length > MAX_TEXT) return null;

  return {
    eventId,
    senderPlatformId: senderId,
    conversationPlatformId: groupId ?? senderId,
    conversationKind: groupId ? 'group' : 'private',
    text,
    timestamp,
    participantPlatformIds: [],
    participantsComplete: false,
  };
}

export function createOneBotAdapter(config: OneBotConfig): OneBotAdapter {
  if (!config.database || !config.characterId || typeof config.onInbound !== 'function') {
    throw new Error('OneBot database, character, and inbound callback required');
  }
  if (config.enabled && (!config.url || !config.accessToken?.trim() || !config.selfId || !ID.test(config.selfId))) {
    throw new Error('enabled OneBot requires URL, token, and self ID');
  }
  if (config.enabled) {
    const url = new URL(config.url!);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
      throw new Error('OneBot requires wss except loopback fixtures');
    }
  }

  let socket: WebSocket | null = null;
  let stopped = true;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let retry = 0;
  const pending = new Map<string, PendingRequest>();

  const rejectPending = () => {
    for (const [echo, request] of pending) {
      clearTimeout(request.timer);
      request.resolve({ kind: 'unknown', errorCode: 'onebot_connection_lost' });
      pending.delete(echo);
    }
  };

  const onMessage = (raw: WebSocket.RawData) => {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (buffer.length > MAX_FRAME) return;

    let value: unknown;
    try {
      value = JSON.parse(buffer.toString('utf8'));
    } catch {
      return;
    }
    if (!value || typeof value !== 'object') return;
    const payload = value as Record<string, unknown>;

    if (typeof payload.echo === 'string' && pending.has(payload.echo)) {
      const request = pending.get(payload.echo)!;
      pending.delete(payload.echo);
      clearTimeout(request.timer);
      request.resolve(payload);
      return;
    }

    const event = normalizeOneBotEvent(payload);
    if (!event || event.senderPlatformId === config.selfId ||
      (payload.self_id !== undefined && platformId(payload.self_id) !== config.selfId)) return;

    const evidence = createVerifiedChannelEvidence(
      'qq', event.conversationPlatformId, event.senderPlatformId, event.conversationKind,
    );
    Promise.resolve(config.onInbound(event, evidence)).catch(() => {});
  };

  const connect = () => {
    if (stopped || !config.enabled) return;
    const current = new WebSocket(config.url!, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      maxPayload: MAX_FRAME,
    });
    socket = current;
    current.on('message', onMessage);
    current.on('open', () => { retry = 0; });
    current.on('close', () => {
      if (socket === current) socket = null;
      rejectPending();
      if (stopped) return;
      const delay = Math.min(
        config.reconnectMaxMs ?? 30_000,
        (config.reconnectMinMs ?? 500) * 2 ** Math.min(retry++, 8),
      );
      reconnectTimer = setTimeout(connect, delay);
      reconnectTimer.unref();
    });
    current.on('error', () => {});
  };

  const request = (
    action: string,
    params: Record<string, unknown>,
    rawNumericId?: RawNumericId,
    timeout = config.requestTimeoutMs ?? 10_000,
  ): Promise<unknown> => new Promise((resolve) => {
    const current = socket;
    if (!current || current.readyState !== WebSocket.OPEN) {
      resolve({ kind: 'not_sent' });
      return;
    }

    const echo = randomUUID();
    const entry: PendingRequest = {
      resolve,
      timer: setTimeout(() => {
        pending.delete(echo);
        resolve({ kind: 'unknown' });
      }, timeout),
    };
    entry.timer.unref();
    pending.set(echo, entry);

    try {
      let body = JSON.stringify({ action, params, echo });
      if (rawNumericId) {
        const marker = `__onebot_numeric_id_${echo}__`;
        body = JSON.stringify({ action, params: { ...params, [rawNumericId.key]: marker }, echo })
          .replace(JSON.stringify(marker), rawNumericId.value);
      }
      current.send(body, (error) => {
        if (error && pending.has(echo)) {
          pending.delete(echo);
          clearTimeout(entry.timer);
          resolve({ kind: 'unknown' });
        }
      });
    } catch {
      pending.delete(echo);
      clearTimeout(entry.timer);
      resolve({ kind: 'not_sent' });
    }
  });

  const start = async () => {
    if (!config.enabled) return;
    stopped = false;
    connect();
  };

  const stop = async () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    rejectPending();
    const current = socket;
    socket = null;
    if (!current) return;
    await new Promise<void>((resolve) => {
      if (current.readyState === WebSocket.CLOSED) return resolve();
      current.once('close', () => resolve());
      current.close(1000, 'shutdown');
      setTimeout(() => {
        current.terminate();
        resolve();
      }, 1_000).unref();
    });
  };

  const fetchCompleteRoster = async (groupId: string) => {
    if (!ID.test(groupId)) throw new Error('invalid group ID');
    const response = await request(
      'get_group_member_list',
      { group_id: `__onebot_numeric_id__` },
      { key: 'group_id', value: groupId },
    ) as Record<string, any>;
    if (response?.kind || response?.status !== 'ok' || response?.retcode !== 0 ||
      !Array.isArray(response.data) || response.data.length < 1 || response.data.length > 1000) {
      throw new Error('complete roster RPC failed');
    }
    const memberIds = response.data.map((member: unknown) => {
      if (!member || typeof member !== 'object') return null;
      return platformId((member as Record<string, unknown>).user_id);
    });
    if (memberIds.some((id: string | null) => !id) || new Set(memberIds).size !== memberIds.length) {
      throw new Error('invalid roster RPC');
    }
    const ids = memberIds as string[];
    return {
      memberIds: ids,
      evidence: createTrustedRosterEvidence('qq', groupId, ids, new Date()),
    };
  };

  const sendDelivery = async (deliveryId: string): Promise<DeliveryResult> => {
    try {
      const [row] = await config.database.db.select({
        content: deliveryOutbox.content,
        kind: conversations.kind,
        channel: conversations.platformConversationId,
        platform: conversations.platform,
      }).from(deliveryOutbox)
        .innerJoin(conversations, eq(deliveryOutbox.conversationId, conversations.id))
        .where(and(
          eq(deliveryOutbox.id, deliveryId),
          eq(conversations.characterId, config.characterId),
        ))
        .limit(1);
      if (!row || row.platform !== 'qq' || !ID.test(row.channel) ||
        (row.kind !== 'private' && row.kind !== 'group')) {
        return { kind: 'not_sent', errorCode: 'invalid_delivery_target' };
      }
      const text = typeof row.content === 'string'
        ? row.content
        : row.content && typeof row.content === 'object' && 'text' in row.content
          ? String((row.content as { text: unknown }).text)
          : '';
      if (!text || text.length > MAX_TEXT) return { kind: 'not_sent', errorCode: 'invalid_delivery_content' };

      const targetKey = row.kind === 'group' ? 'group_id' : 'user_id';
      const action = row.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
      const response = await request(
        action,
        { [targetKey]: '__onebot_numeric_id__', message: text },
        { key: targetKey, value: row.channel },
      ) as Record<string, any>;
      if (response?.kind === 'not_sent') {
        return { kind: 'not_sent', errorCode: 'onebot_disconnected_before_send' };
      }
      if (response?.kind) return { kind: 'unknown', errorCode: 'onebot_send_unknown' };
      const receipt = platformId(response?.data?.message_id);
      if (response?.status === 'ok' && response?.retcode === 0 && receipt) {
        return { kind: 'receipt', receipt };
      }
      if (response?.status === 'failed') return { kind: 'not_sent', errorCode: 'onebot_api_failed' };
      return { kind: 'unknown', errorCode: 'onebot_send_unknown' };
    } catch {
      return { kind: 'unknown', errorCode: 'onebot_send_unknown' };
    }
  };

  return { start, stop, sendDelivery, fetchCompleteRoster };
}
