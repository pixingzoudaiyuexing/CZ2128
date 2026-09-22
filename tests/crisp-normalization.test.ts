import { describe, expect, it } from 'vitest';
import { normalizeCrispEvent } from '../src/index';
import { crispMessageEventId } from '../src/adapters/crisp/webhook';

describe('Crisp event normalization', () => {
  it('isolates website/session identity and preserves a customer text event', async () => {
    const payload = {
      event: 'message:send',
      data: {
        website_id: 'website-a', session_id: 'session-a', fingerprint: 101,
        type: 'text', from: 'user', content: 'Need help', user: { user_id: 'visitor-a', nickname: 'Alice' }
      }
    };
    const event = normalizeCrispEvent(payload, await crispMessageEventId(payload, JSON.stringify(payload)), 'website-a');
    expect(event).toMatchObject({
      source: 'crisp', type: 'message_created',
      payload: {
        websiteRef: 'website-a', sessionRef: 'session-a', customerRef: 'visitor-a',
        messageRef: '101', actorRole: 'CUSTOMER', content: 'Need help'
      }
    });
  });

  it('keeps sessions distinct and filters only fully identified CZ2128 echoes', async () => {
    const first = { event: 'message:send', data: { website_id: 'website-a', session_id: 's1', fingerprint: 1, type: 'text', from: 'user', content: 'A' } };
    const second = { ...first, data: { ...first.data, session_id: 's2' } };
    const firstEvent = normalizeCrispEvent(first, await crispMessageEventId(first, JSON.stringify(first)), 'website-a');
    const secondEvent = normalizeCrispEvent(second, await crispMessageEventId(second, JSON.stringify(second)), 'website-a');
    expect(firstEvent?.eventId).not.toBe(secondEvent?.eventId);
    const legitimateAutomation = normalizeCrispEvent({
      event: 'message:received',
      data: { ...first.data, automated: true, from: 'operator', origin: 'chat', user: { type: 'operator', user_id: 'other-bot' } }
    }, 'automation', 'website-a');
    expect(legitimateAutomation).toMatchObject({ payload: { actorRole: 'OPERATOR', content: 'A' } });

    const markerOnly = normalizeCrispEvent({
      event: 'message:received',
      data: { ...first.data, from: 'operator', properties: { cz2128_operation_id: 'send_crisp_1' } }
    }, 'marker-only', 'website-a');
    expect(markerOnly).not.toBeNull();

    expect(normalizeCrispEvent({
      event: 'message:received',
      data: {
        ...first.data, from: 'operator', origin: 'chat', automated: true,
        user: { type: 'operator', user_id: 'cz2128' },
        properties: { cz2128_operation_id: 'send_crisp_1' }
      }
    }, 'own-echo', 'website-a')).toBeNull();
  });

  it('normalizes operator and picker selection events', async () => {
    const operator = { event: 'message:received', data: { website_id: 'website-a', session_id: 's1', fingerprint: 2, type: 'text', from: 'operator', content: 'Human reply' } };
    const op = normalizeCrispEvent(operator, await crispMessageEventId(operator, JSON.stringify(operator)), 'website-a');
    expect((op?.payload as any).actorRole).toBe('OPERATOR');

    const textChoice = {
      event: 'message:send',
      data: { website_id: 'website-a', session_id: 's1', fingerprint: 4, type: 'text', from: 'user', content: 'human' }
    };
    const normalizedTextChoice = normalizeCrispEvent(
      textChoice, await crispMessageEventId(textChoice, JSON.stringify(textChoice)), 'website-a'
    );
    expect(normalizedTextChoice).toMatchObject({ payload: { content: 'human', actorRole: 'CUSTOMER' } });
    expect((normalizedTextChoice?.payload as any).selection).toBeUndefined();

    const updatedPicker = {
      event: 'message:updated',
      data: {
        website_id: 'website-a', session_id: 's1', fingerprint: 5,
        content: { id: 'main', text: 'Choose', choices: [
          { value: 'sales', label: 'Sales', selected: false },
          { value: 'human', label: 'Human', selected: true }
        ] }
      }
    };
    const updated = normalizeCrispEvent(
      updatedPicker, await crispMessageEventId(updatedPicker, JSON.stringify(updatedPicker)), 'website-a'
    );
    expect(updated).toMatchObject({
      payload: {
        actorRole: 'CUSTOMER', content: 'Human',
        selection: { pickerId: 'main', pickerMessageRef: '5', value: 'human', label: 'Human' }
      }
    });
  });

  it('uses stable provider-qualified Picker selection identity across raw body changes', async () => {
    const base = {
      event: 'message:updated',
      data: {
        website_id: 'website-a', session_id: 'session-a', fingerprint: 77,
        content: { id: 'main', choices: [{ value: 'human', label: 'Human', selected: true }] }
      }
    };
    const sameSelectionDifferentBody = { ...base, data: { ...base.data, timestamp: 999 } };
    const otherPicker = { ...base, data: { ...base.data, fingerprint: 78, content: { ...base.data.content, id: 'secondary' } } };
    const firstId = await crispMessageEventId(base, JSON.stringify(base));
    const duplicateId = await crispMessageEventId(sameSelectionDifferentBody, JSON.stringify(sameSelectionDifferentBody));
    const otherId = await crispMessageEventId(otherPicker, JSON.stringify(otherPicker));
    expect(duplicateId).toBe(firstId);
    expect(otherId).not.toBe(firstId);
    expect(firstId).toMatch(/^crisp:selection:[a-f0-9]{64}$/);
  });

  it('ignores unrelated or ambiguous Picker updates', async () => {
    const noSelection = {
      event: 'message:updated',
      data: { website_id: 'website-a', session_id: 's1', fingerprint: 5, content: { id: 'main', choices: [] } }
    };
    const twoSelections = {
      event: 'message:updated',
      data: {
        website_id: 'website-a', session_id: 's1', fingerprint: 5,
        content: { id: 'main', choices: [
          { value: 'a', label: 'A', selected: true }, { value: 'b', label: 'B', selected: true }
        ] }
      }
    };
    expect(normalizeCrispEvent(noSelection, await crispMessageEventId(noSelection, JSON.stringify(noSelection)), 'website-a')).toBeNull();
    expect(normalizeCrispEvent(twoSelections, await crispMessageEventId(twoSelections, JSON.stringify(twoSelections)), 'website-a')).toBeNull();
  });
});
