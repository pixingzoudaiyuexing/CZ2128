import { AIConfig } from '../../config/ai';
import { AIMessage } from '../../core/ai-context';

export async function generateChatCompletion(
  config: AIConfig,
  messages: AIMessage[]
): Promise<{ success: boolean; content?: string; responseId?: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data: any = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      return { success: false, error: 'Malformed AI response: missing choices[0].message.content' };
    }

    return {
      success: true,
      content: data.choices[0].message.content,
      responseId: data.id || `ai_res_${Date.now()}`
    };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { success: false, error: 'AI request timed out' };
    }
    return { success: false, error: String(err) };
  }
}
