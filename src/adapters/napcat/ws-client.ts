import WebSocket from 'ws';
import type { NapcatActionRequest, NapcatActionResponse } from '../../types/napcat.js';
import { logger } from '../../utils/logger.js';

export interface WsClientOptions {
  url: string;
  accessToken?: string;
  reconnectDelayMs?: number;
  actionTimeoutMs?: number;
  onEvent: (event: unknown) => void | Promise<void>;
}

interface PendingAction {
  resolve: (response: NapcatActionResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class NapcatWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly reconnectDelayMs: number;
  private readonly actionTimeoutMs: number;
  private readonly options: WsClientOptions;
  private isShuttingDown = false;
  private pendingActions = new Map<string, PendingAction>();

  constructor(options: WsClientOptions) {
    this.options = options;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10000;
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

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        const payload = JSON.parse(raw) as unknown;

        if (this.tryResolveAction(payload)) {
          return;
        }

        Promise.resolve(this.options.onEvent(payload)).catch((error) => {
          logger.error({ err: error }, 'Event handler failed');
        });
      } catch (error) {
        logger.error({ err: error }, 'Failed to parse NapCat WS message');
      }
    });

    this.ws.on('error', (error: Error) => {
      logger.error({ err: error }, 'NapCat WebSocket error');
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.warn({ code, reason: reason.toString() }, 'NapCat WebSocket closed');
      this.ws = null;
      this.rejectAllPending(new Error('WebSocket closed before action response'));
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  async sendAction(action: NapcatActionRequest): Promise<NapcatActionResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('NapCat WebSocket is not connected');
    }

    const echo = action.echo ?? `echo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload: NapcatActionRequest = { ...action, echo };

    return new Promise<NapcatActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`NapCat action timeout: ${action.action}`));
      }, this.actionTimeoutMs);

      this.pendingActions.set(echo, { resolve, reject, timer });
      this.ws?.send(JSON.stringify(payload), (error: Error | undefined) => {
        if (error) {
          clearTimeout(timer);
          this.pendingActions.delete(echo);
          reject(error);
        }
      });
    });
  }

  shutdown(): void {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('WebSocket client shutdown'));
    this.ws?.close();
    this.ws = null;
  }

  private tryResolveAction(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const response = payload as NapcatActionResponse;
    if (!response.echo || !this.pendingActions.has(response.echo)) {
      return false;
    }

    const pending = this.pendingActions.get(response.echo);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingActions.delete(response.echo);

    if (response.status === 'failed') {
      pending.reject(new Error(response.message ?? response.wording ?? 'NapCat action failed'));
    } else {
      pending.resolve(response);
    }

    return true;
  }

  private rejectAllPending(error: Error): void {
    for (const [echo, pending] of this.pendingActions.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingActions.delete(echo);
    }
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
