import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeLearningText } from '../src/learning/privacy';
import { captureLearningCandidateByProviderRef } from '../src/learning/repository';
import { extractLearningCandidate } from '../src/learning/extraction';
import { candidateNotionProperties } from '../src/learning/notion-api';
import { SqliteD1 } from './helpers/sqlite-d1';

const TOKEN = 'c'.repeat(43);
const CAPABILITIES = [
  `https://cz2128.482658.xyz/attachments/${TOKEN}/download`,
  `https://cz2128.482658.xyz/attachments/${TOKEN}/inline`,
  `https://cz2128.482658.xyz/uploads/${TOKEN}`,
  `https://cz2128.482658.xyz/upload-sessions/${TOKEN}/page`,
  `https://cz2128.482658.xyz/upload-sessions/${TOKEN}/parts/2`,
  `https://cz2128-4c-staging.example.workers.dev/attachments/${TOKEN}/download?view=1#file`
];

describe('learning capability privacy at persistence and provider boundaries', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(CAPABILITIES)('redacts path capability %s as high risk', url => {
    const result = sanitizeLearningText(`Use this private link (${url}) to download the file.`);
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).toContain('[REDACTED_TEMP_URL]');
    expect(result.riskLevel).toBe('HIGH');
    expect(result.flags).toContain('TEMPORARY_URL');
  });

  it('redacts the whole capability URL before other credential patterns can alter its token', () => {
    const token = 'A'.repeat(16) + '_' + 'B'.repeat(26);
    const result = sanitizeLearningText(`Open https://files.example/uploads/${token}`);
    expect(result.text).toBe('Open [REDACTED_TEMP_URL]');
    expect(result.flags).toContain('TEMPORARY_URL');
  });

  it('keeps path capabilities out of canonical candidates, extraction requests and Notion properties', async () => {
    const db = new SqliteD1();
    try {
      db.migrateThroughHumanLearning();
      db.exec(`
        INSERT INTO conversations
          (id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,created_at,updated_at)
        VALUES ('conv','crisp','site','session','visitor','telegram',1,1);
      `);
      for (const [id, role, direction, content] of [
        ['q', 'CUSTOMER', 'INBOUND', `Can I open ${CAPABILITIES[0]}?`],
        ['a', 'OPERATOR', 'OUTBOUND', `Upload here: ${CAPABILITIES[2]}`]
      ]) {
        await db.prepare(`INSERT INTO messages
          (id,conversation_id,provider,provider_message_ref,direction,actor_role,message_type,text_content,created_at)
          VALUES (?,'conv','crisp',?,?,?,'TEXT',?,1)`)
          .bind(id, id, direction, role, content).run();
      }
      const env = { DB: db, AI_BASE_URL: 'https://ai.example/v1', AI_API_KEY: 'synthetic-key', AI_MODEL: 'synthetic-model' } as any;
      const candidate = await captureLearningCandidateByProviderRef(env, 'crisp', 'a');
      expect(candidate?.review_status).toBe('NEEDS_REVIEW');
      expect(candidate?.risk_level).toBe('HIGH');
      expect(JSON.stringify(candidate)).not.toContain(TOKEN);
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
        choices: [{ message: { content: JSON.stringify({ generalizable: true,
          title: 'Private upload', question: 'How do I upload?', proposed_answer: `Open ${CAPABILITIES[1]}`,
          reason: 'Synthetic reference', risk_flags: [] }) } }]
      }));
      const extracted = await extractLearningCandidate(env, candidate!.id);
      expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain(TOKEN);
      expect(JSON.stringify(extracted)).not.toContain(TOKEN);
      expect(JSON.stringify(candidateNotionProperties(extracted, {}))).not.toContain(TOKEN);
      expect(extracted.risk_level).toBe('HIGH');
      expect(extracted.review_status).toBe('NEEDS_REVIEW');
    } finally { db.close(); }
  });

  it.each(['ai', 'notion'] as const)('re-scans legacy stored material before %s export', async boundary => {
    const db = new SqliteD1();
    try {
      db.migrateThroughHumanLearning();
      db.exec(`INSERT INTO conversations
        (id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,created_at,updated_at)
        VALUES ('conv','crisp','site','session','visitor','telegram',1,1);
        INSERT INTO messages
        (id,conversation_id,provider,provider_message_ref,direction,actor_role,message_type,text_content,created_at)
        VALUES ('a','conv','crisp','a','OUTBOUND','OPERATOR','TEXT','Synthetic answer',1)`);
      const env = { DB: db, AI_BASE_URL: 'https://ai.example/v1', AI_API_KEY: 'synthetic-key', AI_MODEL: 'synthetic-model' } as any;
      const candidate = await captureLearningCandidateByProviderRef(env, 'crisp', 'a');
      await db.prepare(`UPDATE learning_candidates SET sanitized_question=?, sanitized_answer=?,
        extracted_title=?, extracted_question=?, extracted_answer=?, review_notes=?, extraction_reason=?,
        risk_level='LOW', risk_flags_json='[]' WHERE id=?`)
        .bind(CAPABILITIES[0], CAPABILITIES[2], CAPABILITIES[0], CAPABILITIES[1], CAPABILITIES[2],
          CAPABILITIES[0], CAPABILITIES[2], candidate!.id).run();
      const legacy = await db.prepare('SELECT * FROM learning_candidates WHERE id=?').bind(candidate!.id).first<any>();
      if (boundary === 'notion') {
        const properties = candidateNotionProperties(legacy, {});
        expect(JSON.stringify(properties)).not.toContain(TOKEN);
        expect(properties.Risk).toEqual({ select: { name: 'High' } });
        return;
      }

      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
        choices: [{ message: { content: JSON.stringify({ generalizable: true,
          title: 'Safe guidance', question: 'How do I upload?', proposed_answer: 'Ask support for a fresh private link.',
          reason: 'Synthetic guidance', risk_flags: [] }) } }]
      }));
      const extracted = await extractLearningCandidate(env, candidate!.id);
      expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain(TOKEN);
      expect(extracted.risk_level).toBe('HIGH');
      expect(extracted.review_status).toBe('NEEDS_REVIEW');
    } finally { db.close(); }
  });
});
