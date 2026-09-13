const fs = require('fs');
let code = fs.readFileSync('src/core/ai-state.ts', 'utf8');

code = code.replace(
  /const claim = await env\.DB\.prepare\(\n\s*`UPDATE conversations [\s\S]*?AND \(ai_generation_id IS NULL OR ai_generation_started_at < \?\)`\n\s*\)\.bind\(generationId, now, messageId, now, convId, leaseExpiryThreshold\)\.run\(\);/g,
  `if (env.hooks && env.hooks.beforeGenerationLeaseClaim) await env.hooks.beforeGenerationLeaseClaim(env, convId);

  const claim = await env.DB.prepare(
    \`UPDATE conversations 
     SET ai_generation_id = ?,
         ai_generation_started_at = ?,
         ai_generation_message_id = ?,
         updated_at = ?,
         version = version + 1
     WHERE id = ? 
       AND ai_mode = 'ENABLED'
       AND ai_handoff_epoch = ?
       AND (ai_generation_id IS NULL OR ai_generation_started_at < ?)\`
  ).bind(generationId, now, messageId, now, convId, conv.ai_handoff_epoch, leaseExpiryThreshold).run();`
);

fs.writeFileSync('src/core/ai-state.ts', code);
