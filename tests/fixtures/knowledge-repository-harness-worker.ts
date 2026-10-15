import {
  createKnowledgeEntry, deleteKnowledgeEntry, searchKnowledge,
  setKnowledgeEntryEnabled, updateKnowledgeEntry
} from '../../src/knowledge/repository';
import { safeErrorCode } from '../../src/core/errors';

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ok: true });
    if (path === '/snapshot') {
      return Response.json({
        entries: (await env.DB.prepare('SELECT id,title,body,enabled,version FROM knowledge_entries ORDER BY id').all()).results,
        history: (await env.DB.prepare('SELECT entry_id,version,action,source_update_id FROM knowledge_entry_history ORDER BY entry_id,version').all()).results
      });
    }
    const input = await request.json<any>();
    try {
      if (path === '/create') return Response.json(await createKnowledgeEntry(env as any, input.title, input.body, 'synthetic', input.update));
      if (path === '/update') return Response.json(await updateKnowledgeEntry(env as any, input.id, input.version,
        input.title, input.body, 'synthetic', input.update));
      if (path === '/toggle') return Response.json(await setKnowledgeEntryEnabled(env as any, input.id, input.version,
        input.enabled, 'synthetic', input.update));
      if (path === '/delete') {
        await deleteKnowledgeEntry(env as any, input.id, input.version, 'synthetic', input.update);
        return Response.json({ ok: true });
      }
      if (path === '/search') return Response.json(await searchKnowledge(env as any, input.query));
      if (path === '/trigger-metadata') {
        const rows = await env.DB.batch([
          env.DB.prepare(`INSERT INTO knowledge_entries
            (id,title,body,search_terms,enabled,version,created_by,updated_by,created_at,updated_at)
            VALUES ('kb_0000000000000000','trigger probe','old phrase','old phrase',1,1,'synthetic','synthetic',1,1)`),
          env.DB.prepare(`UPDATE knowledge_entries SET body='new phrase',search_terms='new phrase',version=2
            WHERE id='kb_0000000000000000' AND version=1`),
          env.DB.prepare('SELECT changes() AS direct_changes'),
          env.DB.prepare("DELETE FROM knowledge_entries WHERE id='kb_0000000000000000' AND version=2"),
          env.DB.prepare('SELECT changes() AS direct_changes')
        ]);
        return Response.json(rows.map(row => ({ changes: row.meta.changes, results: row.results })));
      }
      if (path === '/history-metadata') {
        const rows = await env.DB.batch([
          env.DB.prepare(`INSERT INTO knowledge_entries
            (id,title,body,search_terms,enabled,version,created_by,updated_by,created_at,updated_at)
            VALUES ('kb_0000000000000001','history probe','old phrase','old phrase',1,1,'synthetic','synthetic',1,1)`),
          env.DB.prepare(`UPDATE knowledge_entries SET title='history probe',body='new phrase',search_terms='new phrase',enabled=1,version=2,updated_by='synthetic',updated_at=2
            WHERE id='kb_0000000000000001' AND version=1`),
          env.DB.prepare(`INSERT INTO knowledge_entry_history(entry_id,version,action,title,body,enabled,actor_user_id,source_update_id,created_at)
            SELECT id,version,'UPDATE',title,body,enabled,'synthetic','probe',2 FROM knowledge_entries
            WHERE id='kb_0000000000000001' AND version=2 AND changes()=1`),
          env.DB.prepare('SELECT changes() AS direct_changes')
        ]);
        return Response.json(rows.map(row => ({ changes: row.meta.changes, results: row.results })));
      }
      if (path === '/lost-cas-history') {
        const rows = await env.DB.batch([
          env.DB.prepare(`UPDATE knowledge_entries SET title='lost CAS',body='must not persist',
            search_terms='must not persist',version=2 WHERE id=? AND version=1 RETURNING id,version`).bind(input.id),
          env.DB.prepare(`INSERT INTO knowledge_entry_history(entry_id,version,action,title,body,enabled,actor_user_id,source_update_id,created_at)
            SELECT id,version,'UPDATE',title,body,enabled,'synthetic','lost-cas',3 FROM knowledge_entries
            WHERE id=? AND version=2 AND changes()=1 RETURNING entry_id,version`).bind(input.id)
        ]);
        return Response.json(rows.map(row => row.results));
      }
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    } catch (error) { return Response.json({ error: safeErrorCode(error) }, { status: 409 }); }
  }
};
