import WebSocket from 'ws';
import type { NapcatActionRequest } from '../../types/napcat.js';
import { logger } from '../../utils/logger.js';

export interface WsClientOptions {
  url: string;
  accessToken?: string;
  reconnectDelayMs?: number;
  onEvent: (event: unknown) => void;
}

export class NapcatWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly reconnectDelayMs: number;
  private readonly options: WsClientOptions;
  private isShuttingDown = false;

  constructor(options: WsClientOptions) {
    this.options = options;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
  }

  connect(): void {
    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers.Authorization = `Bearer ${this.options.accessToken}`;
    }

    logger.info({ url: this.options.url }, 'Connecting to NapCat WebSocket');

    this.ws = new WebSocket(this.options.url, { headers });

    this.ws.on('open', () => {
      logger.info('NapCat WebSocket connected');
    });

    this.ws.on('message', (data) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        const payload = JSON.parse(raw) as unknown;
        this.options.onEvent(payload);
      } catch (error) {
        logger.error({ err: error }, 'Failed to parse NapCat WS message');
      }
    });

    this.ws.on('error', (error) => {
      logger.error({ err: error }, 'NapCat WebSocket error');
    });

    this.ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, 'NapCat WebSocket closed');
      this.ws = null;
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  async sendAction(action: NapcatActionRequest): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('NapCat WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(action));
  }

  shutdown(): void {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    logger.info({ delayMs: this.reconnectDelayMs }, 'Scheduling NapCat reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }
}
