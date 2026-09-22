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

  it('keeps separate sessions distinct and rejects automated echo events', async () => {
    const first = { event: 'message:send', data: { website_id: 'website-a', session_id: 's1', fingerprint: 1, type: 'text', from: 'user', content: 'A' } };
    const second = { ...first, data: { ...first.data, session_id: 's2' } };
    const firstEvent = normalizeCrispEvent(first, await crispMessageEventId(first, JSON.stringify(first)), 'website-a');
    const secondEvent = normalizeCrispEvent(second, await crispMessageEventId(second, JSON.stringify(second)), 'website-a');
    expect(firstEvent?.eventId).not.toBe(secondEvent?.eventId);
    expect(normalizeCrispEvent(
      { event: 'message:received', data: { ...first.data, automated: true, from: 'operator' } },
      'echo', 'website-a'
    )).toBeNull();
    expect(normalizeCrispEvent(
      {
        event: 'message:received',
        data: { ...first.data, from: 'operator', properties: { cz2128_operation_id: 'send_crisp_1' } }
      },
      'echo-marker', 'website-a'
    )).toBeNull();
  });

  it('normalizes operator and picker selection events', async () => {
    const operator = { event: 'message:received', data: { website_id: 'website-a', session_id: 's1', fingerprint: 2, type: 'text', from: 'operator', content: 'Human reply' } };
    const picker = { event: 'message:send', data: { website_id: 'website-a', session_id: 's1', fingerprint: 3, type: 'picker', from: 'user', content: { id: 'main', text: 'human' }, user: { user_id: 'visitor' } } };
    const op = normalizeCrispEvent(operator, await crispMessageEventId(operator, JSON.stringify(operator)), 'website-a');
    const choice = normalizeCrispEvent(picker, await crispMessageEventId(picker, JSON.stringify(picker)), 'website-a');
    expect((op?.payload as any).actorRole).toBe('OPERATOR');
    expect(choice).toMatchObject({ payload: { selectionValue: 'human', actorRole: 'CUSTOMER' } });

    const textChoice = {
      event: 'message:send',
      data: { website_id: 'website-a', session_id: 's1', fingerprint: 4, type: 'text', from: 'user', content: 'human' }
    };
    const normalizedTextChoice = normalizeCrispEvent(
      textChoice, await crispMessageEventId(textChoice, JSON.stringify(textChoice)), 'website-a'
    );
    expect(normalizedTextChoice).toMatchObject({ payload: { selectionValue: 'human' } });

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
    expect(updated).toMatchObject({ payload: { selectionValue: 'human', content: 'human' } });
  });
});
