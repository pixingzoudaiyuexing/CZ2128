import { Env } from '../index';
import { AIConfig } from '../config/ai';

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export async function buildAIContext(
  env: Env,
  convId: string,
  config: AIConfig
): Promise<AIMessage[]> {
  // Use created_at DESC, id DESC for deterministic ordering
  const messages = await env.DB.prepare(
    `SELECT actor_role, text_content 
     FROM messages 
     WHERE conversation_id = ? 
       AND message_type = 'TEXT' 
       AND text_content IS NOT NULL 
       AND actor_role IN ('CUSTOMER', 'AI', 'OPERATOR')
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`
  ).bind(convId, config.contextMaxMessages).all<any>();

  const selected: AIMessage[] = [];
  let charCount = 0;

  for (const row of messages.results) {
    let text = row.text_content || '';
    const role = row.actor_role === 'CUSTOMER' ? 'user' : 'assistant';
    
    // Hard limit truncation
    if (charCount + text.length > config.contextMaxChars) {
      const allowedLength = config.contextMaxChars - charCount;
      if (allowedLength > 0) {
        text = text.substring(0, allowedLength);
        selected.push({ role, content: text });
      }
      break; 
    }

    selected.push({ role, content: text });
    charCount += text.length;
  }

  // Reverse to chronological order (oldest -> newest)
  selected.reverse();

  // Prepend system prompt
  selected.unshift({ role: 'system', content: config.systemPrompt });

  return selected;
}
