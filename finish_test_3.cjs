const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

code = code.replace(/if \(o\) \{ o\.status = this\.boundParams\[0\]; meta\.changes = 1; \}/g,
`if (o) { 
        if (this.query.includes("status = 'FAILED_FINAL'")) { o.status = 'FAILED_FINAL'; }
        else { o.status = this.boundParams[0]; }
        meta.changes = 1; 
      }`);

fs.writeFileSync('tests/ai-handoff.test.ts', code);
