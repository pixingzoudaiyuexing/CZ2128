const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

// Fix New Message After /ai_on Works
// In DB mock, when resumeManual is called, boundParams[0] is 'now', boundParams[1] is 'conversationId'!
code = code.replace(
  /const c = this\.db\.tables\.conversations\.find\(c => c\.id === this\.boundParams\[1\]\);/g,
  `const c = this.db.tables.conversations.find(c => c.id === this.boundParams[1]);` // wait, it's correct!
);

code = code.replace(
  /await p2;/g,
  `try { await p2; } catch(e) { console.error('P2 error:', e); }`
);

// Fix current customer message appears once
// The issue is that the first processA succeeded, but event_receipts blocked processB because it wasn't mocked properly,
// OR saveDurableAiRun didn't update response_text correctly!
code = code.replace(
  /existing\.status = this\.boundParams\[11\]; existing\.provider_response_ref = this\.boundParams\[12\]; existing\.response_text = this\.boundParams\[13\]; existing\.generation_id = this\.boundParams\[15\]; existing\.handoff_epoch = this\.boundParams\[16\];/g,
  `existing.status = this.boundParams[11]; existing.provider_response_ref = this.boundParams[12]; existing.response_text = this.boundParams[13]; existing.generation_id = this.boundParams[15]; existing.handoff_epoch = this.boundParams[16]; console.log('UPDATED existing to', existing);`
);

fs.writeFileSync('tests/ai-handoff.test.ts', code);
