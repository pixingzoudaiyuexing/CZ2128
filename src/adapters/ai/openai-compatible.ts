import { AIConfig } from '../../config/ai';
import { AIMessage } from '../../core/ai-context';

export interface AICompletionResult {
  success: boolean;
  content?: string;
  responseId?: string;
  error?: 'AI_TIMEOUT' | 'AI_TRANSPORT_ERROR' | 'AI_INVALID_RESPONSE' | `AI_HTTP_${number}`;
}

export async function generateChatCompletion(
  config: AIConfig,
  messages: AIMessage[]
): Promise<AICompletionResult> {
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
      body: JSON.stringify({ model: config.model, messages }),
      signal: controller.signal
    });

    if (!response.ok) {
      return { success: false, error: `AI_HTTP_${response.status}` };
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      return { success: false, error: 'AI_INVALID_RESPONSE' };
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { success: false, error: 'AI_INVALID_RESPONSE' };
    }

    const responseId = typeof data.id === 'string' && data.id.length > 0 ? data.id : undefined;
    return { success: true, content, responseId };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, error: 'AI_TIMEOUT' };
    }
    return { success: false, error: 'AI_TRANSPORT_ERROR' };
  } finally {
    clearTimeout(timeoutId);
  }
}
