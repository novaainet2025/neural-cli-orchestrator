export type MeshQueueStatus = 'queued' | 'not_queued';
export type MeshQueueFailureReason = 'mesh_unavailable' | 'recipient_unavailable';

/**
 * Evidence returned by the queueing layer.
 *
 * `queued` means the message was appended to one or more live recipient queues.
 * It does not claim that a recipient process read or acted on the message.
 */
export interface MeshEnqueueReceipt {
  messageId: string;
  targetSessionId: string;
  status: MeshQueueStatus;
  queuedRecipients: number;
  historyRecorded: boolean;
  acknowledged: false;
  reason?: MeshQueueFailureReason;
}

export function createMeshEnqueueReceipt(params: {
  messageId: string;
  targetSessionId: string;
  queuedRecipients: number;
  historyRecorded: boolean;
  meshAvailable: boolean;
}): MeshEnqueueReceipt {
  const queuedRecipients = Number.isFinite(params.queuedRecipients)
    ? Math.max(0, Math.trunc(params.queuedRecipients))
    : 0;
  if (queuedRecipients > 0) {
    return {
      messageId: params.messageId,
      targetSessionId: params.targetSessionId,
      status: 'queued',
      queuedRecipients,
      historyRecorded: params.historyRecorded,
      acknowledged: false,
    };
  }

  return {
    messageId: params.messageId,
    targetSessionId: params.targetSessionId,
    status: 'not_queued',
    queuedRecipients: 0,
    historyRecorded: params.historyRecorded,
    acknowledged: false,
    reason: params.meshAvailable ? 'recipient_unavailable' : 'mesh_unavailable',
  };
}
