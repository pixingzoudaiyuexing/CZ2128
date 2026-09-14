import { AIConfig } from '../../config/ai';
import { AIMessage } from '../../core/ai-context';
import { SafeErrorCode } from '../../core/error-taxonomy';
import { resolveRetryAfterSeconds, retryAfterHeader } from '../../core/retry';

export interface AICompletionSuccess {
  success: true;
  content?: string;
  responseId?: string;
}

export interface AICompletionFailure {
  success: false;
  error: SafeErrorCode;
  retryable: boolean;
  retryAfterSeconds?: number;
  httpStatus?: number;
}

export type AICompletionResult = AICompletionSuccess | AICompletionFailure;

export function classifyAIHttpFailure(status: number, retryAfterHeader?: string | null): AICompletionFailure {
  if (status === 429) {
    return {
      success: false,
      error: 'AI_RATE_LIMITED',
      retryable: true,
      retryAfterSeconds: resolveRetryAfterSeconds({ httpRetryAfter: retryAfterHeader }),
      httpStatus: status
    };
  }
  if (status === 408) return { success: false, error: 'AI_TIMEOUT', retryable: true, httpStatus: status };
  if (status >= 500) return { success: false, error: 'AI_PROVIDER_5XX', retryable: true, httpStatus: status };
  return { success: false, error: 'AI_PROVIDER_4XX', retryable: false, httpStatus: status };
}

function validContext(messages: AIMessage[]): boolean {
  return messages.length > 0 && messages.every(message =>
    ['system', 'user', 'assistant'].includes(message.role) &&
    typeof message.content === 'string' && message.content.trim().length > 0
  );
}

export async function generateChatCompletion(
  config: AIConfig,
  messages: AIMessage[],
  options: { maxTokens?: number } = {}
): Promise<AICompletionResult> {
  if (!validContext(messages)) return { success: false, error: 'AI_CONTEXT_INVALID', retryable: false };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {})
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return classifyAIHttpFailure(response.status, retryAfterHeader(response));
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      return { success: false, error: 'AI_INVALID_RESPONSE', retryable: true };
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { success: false, error: 'AI_INVALID_RESPONSE', retryable: true };
    }

    const responseId = typeof data.id === 'string' && data.id.length > 0 ? data.id : undefined;
    return { success: true, content, responseId };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, error: 'AI_TIMEOUT', retryable: true };
    }
    return { success: false, error: 'AI_TRANSPORT_ERROR', retryable: true };
  } finally {
    clearTimeout(timeoutId);
  }
}
