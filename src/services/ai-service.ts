import axios, { AxiosError } from 'axios';
import { logger } from '../utils/logger.js';
import type { SessionMessage } from '../types/bot.js';

export interface AiServiceOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  timeout: number;
}

export interface AiChatOptions {
  temperature?: number;
  maxTokens?: number;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class AiService {
  constructor(private readonly options: AiServiceOptions) {}

  async chat(messages: SessionMessage[], options: AiChatOptions = {}): Promise<string> {
    try {
      const response = await axios.post<OpenAiChatResponse>(
        '/chat/completions',
        {
          model: this.options.model,
          messages: messages.map((item) => ({ role: item.role, content: item.content })),
          temperature: options.temperature,
          max_tokens: options.maxTokens
        },
        {
          baseURL: this.options.baseURL,
          timeout: this.options.timeout,
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const content = response.data.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('AI response is empty');
      }

      return content;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(
        {
          err: error,
          status: axiosError.response?.status,
          data: axiosError.response?.data
        },
        'AI service request failed'
      );
      throw error;
    }
  }
}
