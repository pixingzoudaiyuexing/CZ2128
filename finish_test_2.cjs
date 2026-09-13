const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

// For CAS:
code = code.replace(/env\.DB\.prepare = \(q\) => \{[\s\S]*?return \{ meta: \{ changes: 0 \} \};\n\s*\}\n\s*\}\)\n\s*\};\n\s*\};/m,
`env.DB = Object.assign(new MockD1(), env.DB);
    const origPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (q) => {
      if (q.includes('ai_generation_id = ?')) {
        return {
          bind: (...args) => ({
             run: async () => ({ meta: { changes: 0 } })
          })
        };
      }
      return origPrepare(q);
    };`);

// For terminal: filter by op17
code = code.replace(/expect\(env\.DB\.tables\.outbound_operations\[0\]\.status\)\.toBe\('FAILED_FINAL'\);/g,
`expect(env.DB.tables.outbound_operations.find(x => x.id === 'op17').status).toBe('FAILED_FINAL');`);

fs.writeFileSync('tests/ai-handoff.test.ts', code);
