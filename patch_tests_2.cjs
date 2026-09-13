const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

code = code.replace(
  /String\(this\.boundParams\[0\]\) && String\(c\.helpdesk_conversation_ref\) === String\(this\.boundParams\[1\]\)/g,
  `String(this.boundParams[1]) && String(c.helpdesk_conversation_ref) === String(this.boundParams[2])`
);

// We should also implement INSERT INTO conversations so it doesn't fail if we don't manually push it!
code = code.replace(
  /if \(this\.query\.includes\("INSERT INTO outbound_operations"\)\) \{/g,
  `if (this.query.includes("INSERT INTO conversations")) {
      this.db.tables.conversations.push({ id: this.boundParams[0], helpdesk_provider: this.boundParams[1], helpdesk_account_ref: this.boundParams[2], helpdesk_conversation_ref: this.boundParams[3], ai_mode: 'ENABLED', ai_handoff_epoch: 0 }); meta.changes = 1;
    } else if (this.query.includes("INSERT INTO outbound_operations")) {`
);

fs.writeFileSync('tests/ai-handoff.test.ts', code);
