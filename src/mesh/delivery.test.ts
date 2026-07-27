import { describe, expect, it } from 'vitest';
import { createMeshEnqueueReceipt } from './delivery.js';

describe('createMeshEnqueueReceipt', () => {
  it('reports queue evidence without inflating it into an acknowledgement', () => {
    expect(createMeshEnqueueReceipt({
      messageId: 'msg_1',
      targetSessionId: 'target',
      queuedRecipients: 1,
      historyRecorded: true,
      meshAvailable: true,
    })).toEqual({
      messageId: 'msg_1',
      targetSessionId: 'target',
      status: 'queued',
      queuedRecipients: 1,
      historyRecorded: true,
      acknowledged: false,
    });
  });

  it('distinguishes an unavailable mesh from an unavailable recipient', () => {
    expect(createMeshEnqueueReceipt({
      messageId: 'msg_2',
      targetSessionId: 'target',
      queuedRecipients: 0,
      historyRecorded: true,
      meshAvailable: false,
    }).reason).toBe('mesh_unavailable');

    expect(createMeshEnqueueReceipt({
      messageId: 'msg_3',
      targetSessionId: 'target',
      queuedRecipients: 0,
      historyRecorded: true,
      meshAvailable: true,
    }).reason).toBe('recipient_unavailable');
  });
});
