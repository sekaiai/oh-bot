import type { BotMessage } from '../../types/bot.js';
import type { NapcatMessageEvent, NapcatMessageSegment } from '../../types/napcat.js';
import { toStringId } from '../../utils/helpers.js';

function extractText(message: NapcatMessageEvent['message'], rawMessage?: string): string {
  if (typeof message === 'string') {
    return message;
  }

  if (Array.isArray(message)) {
    const segments = message as NapcatMessageSegment[];
    return segments
      .filter((segment) => segment.type === 'text')
      .map((segment) => String(segment.data?.text ?? ''))
      .join('')
      .trim();
  }

  return rawMessage ?? '';
}

function hasAtSelf(message: NapcatMessageEvent['message'], selfId: string, rawText: string): boolean {
  if (Array.isArray(message)) {
    return message.some(
      (segment) =>
        segment?.type === 'at' &&
        String((segment.data?.qq as string | number | undefined) ?? '') === selfId
    );
  }

  return rawText.includes(`[CQ:at,qq=${selfId}]`);
}

function cleanMessageText(rawText: string, selfId: string): string {
  return rawText
    .replace(new RegExp(`\\[CQ:at,qq=${selfId}\\]`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseNapcatMessage(event: unknown): BotMessage | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const payload = event as NapcatMessageEvent;

  if (payload.post_type !== 'message') {
    return null;
  }

  if (payload.message_type !== 'private' && payload.message_type !== 'group') {
    return null;
  }

  const selfId = toStringId(payload.self_id);
  const userId = toStringId(payload.user_id);
  const groupId = toStringId(payload.group_id);
  const messageId = toStringId(payload.message_id);

  if (!selfId || !userId || !messageId) {
    return null;
  }

  if (payload.message_type === 'group' && !groupId) {
    return null;
  }

  const rawText = extractText(payload.message, payload.raw_message).trim();
  const isAtBot = hasAtSelf(payload.message, selfId, payload.raw_message ?? rawText);

  return {
    messageId,
    userId,
    groupId: payload.message_type === 'group' ? groupId : undefined,
    chatType: payload.message_type,
    rawText,
    cleanText: cleanMessageText(rawText, selfId),
    isAtBot,
    selfId,
    senderNickname: payload.sender?.card || payload.sender?.nickname,
    time: typeof payload.time === 'number' ? payload.time : Math.floor(Date.now() / 1000),
    rawEvent: event
  };
}
