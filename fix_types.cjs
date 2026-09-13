const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

code = code.replace(/find\(x => /g, 'find((x: any) => ');
code = code.replace(/fetchResolver = \(val\)/g, 'fetchResolver = (val: any)');
code = code.replace(/env\.DB\.prepare = \(q\)/g, 'env.DB.prepare = (q: string)');
code = code.replace(/bind: \(\.\.\.args\)/g, 'bind: (...args: any[])');
code = code.replace(/origPrepare = env\.DB\.prepare\.bind\(env\.DB\);/g, 'origPrepare = env.DB.prepare.bind(env.DB) as any;');

fs.writeFileSync('tests/ai-handoff.test.ts', code);
