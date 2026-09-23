import { describe, expect, it } from 'vitest';
import { crispFingerprintForOperation } from '../src/adapters/crisp/fingerprint';

describe('Crisp deterministic fingerprint', () => {
  it('is stable, positive and within the exact JavaScript integer range', async () => {
    const first = await crispFingerprintForOperation('crisp_welcome:conversation-1');
    const second = await crispFingerprintForOperation('crisp_welcome:conversation-1');
    expect(second).toBe(first);
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(2 ** 48);
  });

  it('uses the operation identity, not message content, as the correlation source', async () => {
    const welcome = await crispFingerprintForOperation('crisp_welcome:conversation-1');
    const picker = await crispFingerprintForOperation('crisp_picker:conversation-1:main');
    expect(picker).not.toBe(welcome);
  });
});
