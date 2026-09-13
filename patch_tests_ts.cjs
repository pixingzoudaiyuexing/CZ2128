const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

code = code.replace(/\(async \(url: any, init: any\) => \{/g, 'async (url: any, init: any) => {');
code = code.replace(/\}\) as any\);/g, '});');
code = code.replace(/vi.mocked\(global.fetch\)\.mockImplementation\(async/g, 'vi.mocked(global.fetch).mockImplementation((async');
code = code.replace(/return Promise\.resolve\(\{ ok: true, json: async \(\) => \(\{ id: 100 \}\) \}\);\n    \}\);/g, 'return Promise.resolve({ ok: true, json: async () => ({ id: 100 }) });\n    }) as any);');

fs.writeFileSync('tests/ai-handoff.test.ts', code);
