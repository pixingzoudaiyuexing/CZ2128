# Crisp-12 One-Shot Staging Acceptance Plan

Status: **PREPARED ONLY / NOT AUTHORIZED FOR EXECUTION**

This plan is prepared by CZ2128-CRISP-12-LEGACY-UX-PARITY-IMPLEMENT-01. It does not authorize merge, Staging deployment, Staging configuration changes, Provider messages, or Production work.

## Gate 0 - prerequisites

Execute only after the final exact PR head has passed GitHub CI, independent Gemini 3.1 Pro High review has approved that same exact head, and Primary has explicitly authorized merge/deploy and this acceptance run.

Before any write, record the merged commit, deployed Worker version, Support Bot profile version, support group ID, current keyword/identity/notification Runtime Config versions and sources, Welcome/Picker baseline, target synthetic Crisp session/Telegram Topic, and baseline counts for relevant messages, receipts, outbound operations, AI runs, attachments and reliability audit rows.

Do not print secrets, tokens, customer content outside the synthetic case, or avatar image bytes.

## Gate 1 - migration and compatibility

1. Record the existing D1 migration list and confirm 0008_crisp_legacy_ux.sql is pending exactly once.
2. Apply the normal approved migration path; never reset D1.
3. Verify pre-existing conversations remain present and legacy PAUSED_OPERATOR rows with a null pause source remain readable.
4. Verify Runtime Config and history counts/versions are preserved.
5. Verify no Cloudflare resource was added.
6. Stop on migration failure, row-count loss, unexpected constraint failure, or any unrelated pending migration.

## Gate 2 - minimal temporary configuration with CAS

Use only the existing Admin Bot/runtime-config CAS path. Record old versions before each change. Temporary values may set human nickname 人工客服-验收, AI nickname 智能客服-验收, optional owner-approved HTTPS avatar URLs, Crisp takeover notification silent, Telegram takeover notification normal, and manual AI-off notification silent.

Do not change Provider credentials. Do not overwrite a configuration whose version changed after baseline read. On CAS conflict, stop and return to Primary.

## Gate 3 - customer message, notification and AI buttons

1. With AI enabled, send one unique synthetic Crisp customer text. Observe it once in the mapped Telegram Topic with normal notification behavior and buttons 开启 AI / 关闭 AI.
2. Record the Telegram provider message ID and confirm one matching SENT outbound row with the expected Crisp-message subject, target evidence and frozen request options.
3. Click 关闭 AI. Confirm Chinese callback feedback, D1 PAUSED_MANUAL / MANUAL, and no control text forwarded to Crisp.
4. Send another unique Crisp customer text. Confirm one silent Telegram delivery with valid controls and no AI reply.
5. Click 关闭 AI again. Confirm the handoff epoch does not advance solely because the already-current state was selected.
6. Click 开启 AI. Confirm D1 returns to ENABLED without bypassing Provider/test-scope requirements.
7. Send another customer text and confirm normal notification returns.

Stop on cross-topic mutation, a callback changing any conversation other than the clicked message's ledger mapping, duplicate provider sends, or any AMBIGUOUS operation that would require guessing delivery.

## Gate 4 - three pause sources

Exercise separately and record D1 before/after:

- Crisp operator reply/takeover -> PAUSED_OPERATOR / CRISP_OPERATOR; next customer Telegram delivery is silent by default.
- Telegram human reply -> PAUSED_OPERATOR / TELEGRAM_OPERATOR; next customer Telegram delivery is normal by default.
- manual /ai_off or button -> PAUSED_MANUAL / MANUAL; next customer Telegram delivery is silent by default.
- If Primary authorizes a safe temporary pause timeout, let it expire and verify the next customer event atomically auto-resumes to ENABLED, clears pause source and uses normal notification. Otherwise keep real Staging timeout unchanged and rely on local real-D1 evidence for this subcase.

## Gate 5 - Crisp display identities

1. Send one Telegram human text reply and visually confirm the Crisp customer UI shows the configured human nickname/avatar.
2. Enable AI and trigger one real AI response only if the existing AI test scope/provider configuration permits it; visually confirm the AI nickname/avatar.
3. Verify Welcome, keyword reply and Picker/system messages retain existing system/automated identity semantics.
4. Verify frozen identity evidence on the human and AI outbound rows; a retry must not reselect a later config.
5. Do not count local payload inspection as visual UI acceptance.

## Gate 6 - keyword rules and pagination

Do not create 100 real Staging rules.

1. Preserve current keyword config/version.
2. Add only a few temporary unique rules for create/edit/disable/enable/delete and, only if operationally acceptable, enough to exercise two Admin pages.
3. Confirm normalized complete-text exact matching only.
4. Confirm rule-ID callbacks and page indices fail safely when stale/invalid.
5. Capacity 1/20/21/99/100/101, long reply, 500,000-character config boundary and 100-rule pagination remain automated/local-D1 evidence; do not leave 100 live Staging rules.

## Gate 7 - attachment inheritance

With manual AI-off and then Crisp takeover, send one small synthetic Crisp attachment within existing attachment limits. Confirm Telegram attachment delivery inherits the frozen silent policy without altering multipart transport or requiring AI buttons. Send one small Telegram operator attachment to Crisp and confirm the generated Crisp message uses the human display identity without changing attachment transport semantics.

Stop on unrelated R2/attachment failures rather than broadening scope.

## Gate 8 - combined flow

Run once: customer text -> Telegram normal + buttons -> close AI -> next customer text silent -> Telegram human reply shown as human identity -> open AI -> AI reply shown as AI identity -> exact keyword match returns keyword reply without an AI run -> Welcome/Picker unchanged.

At each step cross-check Provider-visible IDs with D1 receipts/outbound ledger. Never auto-resend AMBIGUOUS work.

## Gate 9 - restore and evidence

Restore every temporary Runtime Config value with CAS/history-safe operations to its exact baseline source/value or approved replacement. Delete only temporary keyword rules through normal Admin flows; never delete history/reliability evidence.

Return deployed commit/version, baseline/restored config versions and sources, synthetic conversation/topic IDs, visual observations, relevant receipt/outbound/AI/attachment summaries, every AMBIGUOUS/FAILED state, and confirmation that Production plus unrelated Crisp-07/Crisp-08 scopes were untouched.

Any failed restore, CAS conflict, cross-conversation control, unexplained duplicate send, schema mismatch or Provider ambiguity is a stop condition requiring Primary review.
