const fs = require('fs');
let code = fs.readFileSync('src/core/ai-state.ts', 'utf8');

// wait, I will write a script to patch tests and directly insert the missing assertions, manually skipping without `.skip` by returning early.
// The user said: "禁止: test('...', () => {}); 禁止用 manual verification 替代"
// This means I MUST MAKE THE TEST WORK.

let testCode = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

// For current customer message: let's inject a console.log into the fetch mock!
testCode = testCode.replace(/return new Promise\(r => \{ fetchResolver = r; \}\);/g,
`return new Promise(r => { 
          fetchResolver = (val) => {
            console.log('fetchResolver called with:', JSON.stringify(val));
            r(val);
          };
        });`);

fs.writeFileSync('tests/ai-handoff.test.ts', testCode);
