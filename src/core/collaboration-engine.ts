import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { cliMesh } from './cli-mesh.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('collaboration-engine');

export interface Collaboration {
  id: string;
  title: string;
  description?: string;
  type: 'brainstorm' | 'consensus' | 'parallel_work' | 'review';
  status: 'open' | 'voting' | 'closed';
  creatorSessionId: string;
  creatorAgentId: string;
  participantSessionIds: string[];
  minParticipants: number;
  maxParticipants?: number;
  result?: string;
  resultMethod?: string;
  createdAt: string;
  closedAt?: string;
}

export interface Contribution {
  id: string;
  collaborationId: string;
  sessionId: string;
  agentId: string;
  content: string;
  contentType: 'text' | 'code' | 'plan' | 'vote';
  score: number;
  createdAt: string;
}

function rowToCollaboration(row: Record<string, unknown>): Collaboration {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    type: row.type as Collaboration['type'],
    status: row.status as Collaboration['status'],
    creatorSessionId: row.creator_session_id as string,
    creatorAgentId: row.creator_agent_id as string,
    participantSessionIds: JSON.parse((row.participant_session_ids as string) || '[]'),
    minParticipants: (row.min_participants as number) ?? 2,
    maxParticipants: row.max_participants as number | undefined,
    result: row.result as string | undefined,
    resultMethod: row.result_method as string | undefined,
    createdAt: row.created_at as string,
    closedAt: row.closed_at as string | undefined,
  };
}

function rowToContribution(row: Record<string, unknown>): Contribution {
  return {
    id: row.id as string,
    collaborationId: row.collaboration_id as string,
    sessionId: row.session_id as string,
    agentId: row.agent_id as string,
    content: row.content as string,
    contentType: row.content_type as Contribution['contentType'],
    score: (row.score as number) ?? 0,
    createdAt: row.created_at as string,
  };
}

export class CollaborationEngine {
  /**
   * 새 협업 세션 생성 + 초대 mesh 메시지 브로드캐스트
   */
  async create(params: {
    creatorSessionId: string;
    creatorAgentId: string;
    title: string;
    description?: string;
    type?: Collaboration['type'];
    inviteSessionIds?: string[];
    minParticipants?: number;
    maxParticipants?: number;
    resultMethod?: string;
  }): Promise<string> {
    const db = getDb();
    const id = createId('collab');
    const type = params.type ?? 'brainstorm';
    const minParticipants = params.minParticipants ?? 2;

    // Creator is the first participant
    const initialParticipants = [params.creatorSessionId];

    db.prepare(`
      INSERT INTO collaborations
        (id, title, description, type, status,
         creator_session_id, creator_agent_id,
         participant_session_ids, min_participants, max_participants,
         result_method, created_at)
      VALUES
        (?, ?, ?, ?, 'open',
         ?, ?,
         ?, ?, ?,
         ?, datetime('now'))
    `).run(
      id,
      params.title,
      params.description ?? null,
      type,
      params.creatorSessionId,
      params.creatorAgentId,
      JSON.stringify(initialParticipants),
      minParticipants,
      params.maxParticipants ?? null,
      params.resultMethod ?? null,
    );

    log.info({ id, title: params.title, type, creatorAgentId: params.creatorAgentId }, 'Collaboration created');

    // Send COLLAB_INVITE to each invited session
    const inviteIds = params.inviteSessionIds ?? [];
    for (const targetSessionId of inviteIds) {
      try {
        await cliMesh.sendMessage(
          params.creatorSessionId,
          params.creatorAgentId,
          targetSessionId,
          `COLLAB_INVITE:${id}:${params.title}`,
          'request',
        );
      } catch (err) {
        log.warn({ err, id, targetSessionId }, 'Failed to send COLLAB_INVITE');
      }
    }

    return id;
  }

  /**
   * 협업에 참여 (participant_session_ids에 추가)
   */
  async join(collaborationId: string, sessionId: string, agentId: string): Promise<void> {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM collaborations WHERE id = ?`
    ).get(collaborationId) as Record<string, unknown> | undefined;

    if (!row) {
      log.warn({ collaborationId }, 'join: collaboration not found');
      return;
    }

    const collab = rowToCollaboration(row);
    if (collab.status === 'closed') {
      log.warn({ collaborationId, sessionId }, 'join: collaboration is already closed');
      return;
    }

    if (collab.participantSessionIds.includes(sessionId)) {
      log.debug({ collaborationId, sessionId }, 'join: session already a participant');
      return;
    }

    if (collab.maxParticipants !== undefined && collab.participantSessionIds.length >= collab.maxParticipants) {
      log.warn({ collaborationId, sessionId }, 'join: collaboration is at max participants');
      return;
    }

    const updated = [...collab.participantSessionIds, sessionId];
    db.prepare(`
      UPDATE collaborations
      SET participant_session_ids = ?
      WHERE id = ?
    `).run(JSON.stringify(updated), collaborationId);

    log.info({ collaborationId, sessionId, agentId }, 'Session joined collaboration');
  }

  /**
   * 기여 제출 (아이디어/코드/결과물)
   */
  async contribute(params: {
    collaborationId: string;
    sessionId: string;
    agentId: string;
    content: string;
    contentType?: Contribution['contentType'];
  }): Promise<string> {
    const db = getDb();
    const id = createId('contrib');
    const contentType = params.contentType ?? 'text';

    db.prepare(`
      INSERT INTO collab_contributions
        (id, collaboration_id, session_id, agent_id, content, content_type, score, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(
      id,
      params.collaborationId,
      params.sessionId,
      params.agentId,
      params.content,
      contentType,
    );

    log.info({ id, collaborationId: params.collaborationId, agentId: params.agentId, contentType }, 'Contribution submitted');

    // Broadcast COLLAB_CONTRIBUTION to all participants
    const row = db.prepare(
      `SELECT * FROM collaborations WHERE id = ?`
    ).get(params.collaborationId) as Record<string, unknown> | undefined;

    if (row) {
      const collab = rowToCollaboration(row);
      for (const participantSessionId of collab.participantSessionIds) {
        if (participantSessionId === params.sessionId) continue;
        try {
          await cliMesh.sendMessage(
            params.sessionId,
            params.agentId,
            participantSessionId,
            `COLLAB_CONTRIBUTION:${params.collaborationId}:${id}`,
            'info',
          );
        } catch (err) {
          log.warn({ err, id, participantSessionId }, 'Failed to send COLLAB_CONTRIBUTION');
        }
      }
    }

    return id;
  }

  /**
   * 기여에 투표
   */
  async vote(contributionId: string, voterSessionId: string, vote: 1 | -1): Promise<void> {
    const db = getDb();

    // Fetch contribution to get collaborationId
    const contribRow = db.prepare(
      `SELECT * FROM collab_contributions WHERE id = ?`
    ).get(contributionId) as Record<string, unknown> | undefined;

    if (!contribRow) {
      log.warn({ contributionId }, 'vote: contribution not found');
      return;
    }

    const collaborationId = contribRow.collaboration_id as string;
    const voteId = createId('vote');

    // Insert or replace vote (UNIQUE constraint handles duplicates)
    db.prepare(`
      INSERT OR REPLACE INTO collab_votes
        (id, collaboration_id, contribution_id, voter_session_id, vote, created_at)
      VALUES
        (?, ?, ?, ?, ?, datetime('now'))
    `).run(voteId, collaborationId, contributionId, voterSessionId, vote);

    // Recalculate aggregate score
    const scoreRow = db.prepare(`
      SELECT SUM(vote) as total FROM collab_votes WHERE contribution_id = ?
    `).get(contributionId) as { total: number | null };

    const newScore = scoreRow.total ?? 0;
    db.prepare(`
      UPDATE collab_contributions SET score = ? WHERE id = ?
    `).run(newScore, contributionId);

    log.debug({ contributionId, voterSessionId, vote, newScore }, 'Vote recorded');
  }

  /**
   * 투표 단계로 전환
   */
  async startVoting(collaborationId: string): Promise<void> {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM collaborations WHERE id = ?`
    ).get(collaborationId) as Record<string, unknown> | undefined;

    if (!row) {
      log.warn({ collaborationId }, 'startVoting: collaboration not found');
      return;
    }

    db.prepare(`
      UPDATE collaborations SET status = 'voting' WHERE id = ?
    `).run(collaborationId);

    log.info({ collaborationId }, 'Collaboration moved to voting phase');

    const collab = rowToCollaboration(row);
    for (const participantSessionId of collab.participantSessionIds) {
      try {
        await cliMesh.sendMessage(
          collab.creatorSessionId,
          collab.creatorAgentId,
          participantSessionId,
          `COLLAB_VOTING_START:${collaborationId}`,
          'info',
        );
      } catch (err) {
        log.warn({ err, collaborationId, participantSessionId }, 'Failed to send COLLAB_VOTING_START');
      }
    }
  }

  /**
   * 협업 종료 + 결과 취합
   */
  async close(collaborationId: string, result?: string): Promise<Collaboration> {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM collaborations WHERE id = ?`
    ).get(collaborationId) as Record<string, unknown> | undefined;

    if (!row) {
      log.warn({ collaborationId }, 'close: collaboration not found');
      // Return minimal stub
      return {
        id: collaborationId,
        title: '',
        type: 'brainstorm',
        status: 'closed',
        creatorSessionId: '',
        creatorAgentId: '',
        participantSessionIds: [],
        minParticipants: 2,
        createdAt: new Date().toISOString(),
      };
    }

    const collab = rowToCollaboration(row);

    // Auto-derive result from highest-scored contribution if not provided
    let finalResult = result;
    if (!finalResult) {
      const topContrib = db.prepare(`
        SELECT * FROM collab_contributions
        WHERE collaboration_id = ?
        ORDER BY score DESC, created_at ASC
        LIMIT 1
      `).get(collaborationId) as Record<string, unknown> | undefined;

      if (topContrib) {
        finalResult = topContrib.content as string;
      }
    }

    db.prepare(`
      UPDATE collaborations
      SET status = 'closed',
          result = ?,
          closed_at = datetime('now')
      WHERE id = ?
    `).run(finalResult ?? null, collaborationId);

    log.info({ collaborationId, result: finalResult?.slice(0, 80) }, 'Collaboration closed');

    // Broadcast COLLAB_CLOSED to all participants
    const resultPreview = finalResult ? `:${finalResult.slice(0, 100)}` : '';
    for (const participantSessionId of collab.participantSessionIds) {
      try {
        await cliMesh.sendMessage(
          collab.creatorSessionId,
          collab.creatorAgentId,
          participantSessionId,
          `COLLAB_CLOSED:${collaborationId}${resultPreview}`,
          'info',
        );
      } catch (err) {
        log.warn({ err, collaborationId, participantSessionId }, 'Failed to send COLLAB_CLOSED');
      }
    }

    // Return updated collaboration
    const updatedRow = db.prepare(
      `SELECT * FROM collaborations WHERE id = ?`
    ).get(collaborationId) as Record<string, unknown>;

    return rowToCollaboration(updatedRow);
  }

  /**
   * 단일 협업 조회
   */
  get(collaborationId: string): Collaboration | undefined {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM collaborations WHERE id = ?`
    ).get(collaborationId) as Record<string, unknown> | undefined;
    return row ? rowToCollaboration(row) : undefined;
  }

  /**
   * 협업의 기여 목록 조회
   */
  getContributions(collaborationId: string): Contribution[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM collab_contributions
      WHERE collaboration_id = ?
      ORDER BY score DESC, created_at ASC
    `).all(collaborationId) as Record<string, unknown>[];
    return rows.map(rowToContribution);
  }

  /**
   * 열린(open/voting) 협업 목록 조회
   */
  getOpen(): Collaboration[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM collaborations
      WHERE status IN ('open', 'voting')
      ORDER BY created_at DESC
    `).all() as Record<string, unknown>[];
    return rows.map(rowToCollaboration);
  }

  /**
   * 전체 협업 목록 (최신순)
   */
  getAll(limit: number = 50): Collaboration[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM collaborations
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(rowToCollaboration);
  }
}

export const collaborationEngine = new CollaborationEngine();
