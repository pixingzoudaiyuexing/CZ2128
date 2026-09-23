export class RuntimeDb {
  runtime: any[] = [];
  history: any[] = [];
  sessions: any[] = [];
  receipts: any[] = [];
  conversations: any[] = [];
  nextHistoryId = 1;
  failBatch = false;
  runtimeListReads = 0;

  prepare(query: string) {
    let params: any[] = [];
    const statement = {
      bind: (...values: any[]) => { params = values; return statement; },
      first: async () => this.first(query, params),
      all: async () => this.all(query, params),
      run: async () => this.run(query, params)
    };
    return statement;
  }

  async batch(statements: any[]) {
    if (this.failBatch) throw new Error('D1_BATCH_FAILED');
    const snapshot = structuredClone({
      runtime: this.runtime,
      history: this.history,
      sessions: this.sessions,
      receipts: this.receipts,
      conversations: this.conversations,
      nextHistoryId: this.nextHistoryId
    });
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  private first(query: string, params: any[]) {
    if (query.includes('MAX(version)')) {
      const versions = this.history.filter(row => row.key === params[0]).map(row => row.version);
      return { version: versions.length ? Math.max(...versions) : 0 };
    }
    if (query.includes('FROM runtime_config_history WHERE id')) {
      return structuredClone(this.history.find(row => row.id === params[0]) || null);
    }
    if (query.includes('FROM runtime_config_history WHERE key = ? AND version = ?')) {
      return structuredClone(this.history.find(
        row => row.key === params[0] && row.version === params[1] && row.is_deleted === 0
      ) || null);
    }
    if (query.includes('FROM runtime_config WHERE key')) {
      return structuredClone(this.runtime.find(row => row.key === params[0]) || null);
    }
    if (query.includes('FROM admin_sessions')) {
      return structuredClone(this.sessions.find(row => row.admin_user_id === params[0] && row.expires_at > params[1]) || null);
    }
    return null;
  }

  private all(query: string, params: any[]) {
    if (query.includes('FROM runtime_config_history ORDER BY')) {
      return { results: structuredClone(this.history.slice().sort((a, b) => b.id - a.id).slice(0, params[0])) };
    }
    if (query.includes('FROM runtime_config ORDER BY')) {
      this.runtimeListReads += 1;
      return { results: structuredClone(this.runtime.slice().sort((a, b) => a.key.localeCompare(b.key))) };
    }
    return { results: [] };
  }

  private run(query: string, params: any[]) {
    let changes = 0;
    if (query.includes('INSERT INTO runtime_config\n')) {
      if (!this.runtime.some(row => row.key === params[0])) {
        this.runtime.push({
          key: params[0], value_kind: params[1], value_text: params[2], ciphertext: params[3],
          nonce: params[4], version: params[5], updated_by: params[6], updated_at: params[7]
        });
        changes = 1;
      }
    } else if (query.includes('UPDATE runtime_config\n')) {
      const row = this.runtime.find(item => item.key === params[7] && item.version === params[8]);
      if (row) {
        Object.assign(row, {
          value_kind: params[0], value_text: params[1], ciphertext: params[2], nonce: params[3],
          version: params[4], updated_by: params[5], updated_at: params[6]
        });
        changes = 1;
      }
    } else if (query.includes('INSERT INTO runtime_config_history')) {
      const deleted = query.includes("'RESTORE_ENV'");
      const key = params[0];
      const version = params[1];
      const condition = deleted
        ? !this.runtime.some(row => row.key === params[6])
        : this.runtime.some(row => row.key === params[10] && row.version === params[11]);
      if (condition) {
        if (this.history.some(row => row.key === key && row.version === version)) {
          throw new Error('UNIQUE_HISTORY');
        }
        this.history.push(deleted ? {
          id: this.nextHistoryId++, key, version, value_kind: params[2], value_text: null,
          ciphertext: null, nonce: null, is_deleted: 1, actor_user_id: params[3],
          action: 'RESTORE_ENV', source_update_id: params[4], created_at: params[5]
        } : {
          id: this.nextHistoryId++, key, version, value_kind: params[2], value_text: params[3],
          ciphertext: params[4], nonce: params[5], is_deleted: 0, actor_user_id: params[6],
          action: params[7], source_update_id: params[8], created_at: params[9]
        });
        changes = 1;
      }
    } else if (query.startsWith('DELETE FROM runtime_config ')) {
      const index = this.runtime.findIndex(row => row.key === params[0] && row.version === params[1]);
      if (index >= 0) { this.runtime.splice(index, 1); changes = 1; }
    } else if (query.includes('UPDATE conversations')) {
      for (const row of this.conversations) {
        if (row.operator_channel === 'telegram' && row.operator_thread_ref !== null) {
          row.operator_thread_ref = null;
          row.operator_thread_status = 'OPEN';
          row.version += 1;
          changes += 1;
        }
      }
    } else if (query.includes('INSERT INTO admin_sessions')) {
      const row = {
        admin_user_id: params[0], action: params[1], target: params[2], expected_version: params[3],
        candidate_value_text: params[4], candidate_ciphertext: params[5], candidate_nonce: params[6],
        context_json: params[7], expires_at: params[8], updated_at: params[9]
      };
      const index = this.sessions.findIndex(item => item.admin_user_id === row.admin_user_id);
      if (index >= 0) this.sessions[index] = row;
      else this.sessions.push(row);
      changes = 1;
    } else if (query.startsWith('DELETE FROM admin_sessions')) {
      const index = this.sessions.findIndex(row => row.admin_user_id === params[0]);
      if (index >= 0) { this.sessions.splice(index, 1); changes = 1; }
    } else if (query.includes('INSERT INTO admin_update_receipts')) {
      if (!this.receipts.some(row => row.update_id === params[0])) {
        this.receipts.push({ update_id: params[0], admin_user_id: params[1], status: 'PROCESSING', created_at: params[2] });
        changes = 1;
      }
    } else if (query.includes('UPDATE admin_update_receipts')) {
      const row = this.receipts.find(item => item.update_id === params[4] && item.status === 'PROCESSING');
      if (row) {
        Object.assign(row, { status: params[0], action: params[1], error_code: params[2], processed_at: params[3] });
        changes = 1;
      }
    }
    return { meta: { changes } };
  }
}

export function masterKey(fill = 7): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
