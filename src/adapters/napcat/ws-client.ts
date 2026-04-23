/**
 * NapCat WebSocket 客户端封装。
 *
 * 该模块负责：
 * 1. 建立与 NapCat 的 WS 连接；
 * 2. 统一处理事件反序列化；
 * 3. 在连接断开时执行有限度的自动重连；
 * 4. 对外暴露一个最小的“发送动作”接口。
 *
 * 这里刻意没有把事件路由、业务回调、响应匹配写进客户端内部，
 * 目的是保持它只关注传输层状态，而不是演化成一个难维护的全功能协议栈。
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { NapcatActionRequest, NapcatActionResponse } from '../../types/napcat.js';
import { logger } from '../../utils/logger.js';

/**
 * WS 客户端初始化参数。
 */
export interface WsClientOptions {
  /** NapCat 正向 WebSocket 地址。 */
  url: string;
  /** 可选鉴权 token；为空时不发送 Authorization 头。 */
  accessToken?: string;
  /** 断线重连等待时间，单位毫秒。 */
  reconnectDelayMs?: number;
  /** 上层事件回调，收到并解析 JSON 后原样透传。 */
  onEvent: (event: unknown) => void | Promise<void>;
}

/**
 * 面向 NapCat 的最小 WebSocket 客户端。
 *
 * 关键状态：
 * - `ws`：当前活跃连接；断开后会置空，避免误用旧连接。
 * - `reconnectTimer`：用于避免重复调度多个重连任务。
 * - `isShuttingDown`：区分“意外断连”与“主动退出”，防止退出时继续重连。
 */
export class NapcatWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly reconnectDelayMs: number;
  private readonly options: WsClientOptions;
  private isShuttingDown = false;
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (response: NapcatActionResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(options: WsClientOptions) {
    this.options = options;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
  }

  /**
   * 建立 WebSocket 连接。
   *
   * 该方法只负责发起一次连接并注册事件监听。
   * 断线后的续连由 `close` 事件统一触发，以免在多个失败路径中重复实现重连逻辑。
   */
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
        this.resolvePendingRequest(payload);
        // 传输层只保证“这是 JSON”，至于事件语义是否合法，由上层适配器继续判断。
        Promise.resolve(this.options.onEvent(payload)).catch((error) => {
          logger.error({ err: error }, 'NapCat event handler failed');
        });
      } catch (error) {
        /**
         * 任意一条坏消息都不应拖垮整条连接。
         * 这里选择记录错误并继续消费后续消息，而不是关闭连接做激进恢复。
         */
        logger.error({ err: error }, 'Failed to parse NapCat WS message');
      }
    });

    this.ws.on('error', (error) => {
      logger.error({ err: error }, 'NapCat WebSocket error');
    });

    this.ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, 'NapCat WebSocket closed');
      this.ws = null;
      this.rejectPendingRequests(new Error(`NapCat WebSocket closed: ${code}`));
      if (!this.isShuttingDown) {
        // 只有“非主动关闭”才会进入自动重连，否则退出流程会被连接层反复拉起。
        this.scheduleReconnect();
      }
    });
  }

  /**
   * 发送 OneBot 动作请求。
   *
   * 输入：符合 NapCat / OneBot 约定的动作对象。
   * 输出：Promise<void>；表示请求已写入 socket，不代表对端已经成功执行。
   *
   * 当前实现不做 echo 追踪，因此如果后续要做“发送确认”或“请求响应匹配”，
   * 应在这里向上扩展，而不是在业务层直接操作底层 `ws`。
   */
  async sendAction(action: NapcatActionRequest): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('NapCat WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(action));
  }

  /**
   * 主动关闭客户端并停止后续重连。
   *
   * 退出阶段先设置 `isShuttingDown`，再清理定时器、关闭连接，
   * 是为了确保任何随后触发的 `close` 回调都不会再次安排重连。
   */
  shutdown(): void {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.rejectPendingRequests(new Error('NapCat WebSocket client is shutting down'));
  }

  async requestAction<T = unknown>(action: NapcatActionRequest, timeoutMs = 10000): Promise<NapcatActionResponse & { data?: T }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('NapCat WebSocket is not connected');
    }

    const echo = action.echo || `echo-${randomUUID()}`;

    const response = await new Promise<NapcatActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error(`NapCat action timed out: ${action.action}`));
      }, timeoutMs);

      this.pendingRequests.set(echo, { resolve, reject, timer });
      this.ws?.send(JSON.stringify({ ...action, echo }));
    });

    if (response.status === 'failed') {
      throw new Error(response.message || response.wording || `NapCat action failed: ${action.action}`);
    }

    return response as NapcatActionResponse & { data?: T };
  }

  /**
   * 延迟调度下一次重连。
   *
   * 这里没有指数退避，只做固定延迟。
   * 原因不是不能做，而是当前系统外部依赖单一，固定间隔已足够简单可控；
   * 若未来出现频繁断线或限流问题，再在这一层统一升级策略即可。
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      // 已有待执行重连时直接返回，避免多个 close/error 路径重复排队。
      return;
    }

    logger.info({ delayMs: this.reconnectDelayMs }, 'Scheduling NapCat reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private resolvePendingRequest(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const echo = 'echo' in payload ? payload.echo : undefined;
    if (typeof echo !== 'string') {
      return;
    }

    const pending = this.pendingRequests.get(echo);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(echo);
    pending.resolve(payload as NapcatActionResponse);
  }

  private rejectPendingRequests(error: Error): void {
    for (const [echo, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(echo);
    }
  }
}
