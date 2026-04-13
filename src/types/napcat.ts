export interface NapcatMessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface NapcatSender {
  user_id?: number;
  nickname?: string;
  card?: string;
}

export interface NapcatMessageEvent {
  post_type?: string;
  message_type?: 'private' | 'group';
  sub_type?: string;
  self_id?: number;
  time?: number;
  user_id?: number;
  group_id?: number;
  message_id?: number;
  raw_message?: string;
  message?: string | NapcatMessageSegment[];
  sender?: NapcatSender;
  [key: string]: unknown;
}

export interface NapcatActionRequest {
  action: string;
  params?: Record<string, unknown>;
  echo?: string;
}

export interface NapcatActionResponse {
  status?: 'ok' | 'failed';
  retcode?: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: string;
}
