import { createWriteStream } from 'fs';
import { join } from 'path';
import { nanoid } from 'nanoid';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';

// 토론 보고서 생성기
export class ReportGenerator {
  private readonly outputDir: string;
  private readonly templatePath: string;

  constructor() {
    this.outputDir = config.get('report.outputDir') || './reports';
    this.templatePath = join(__dirname, 'templates', 'report-template.md');
  }

  async generateReport(
    discussionId: string,
    title: string,
    summary: string,
    participants: string[],
    finalDecision: string,
    timestamp: string = new Date().toISOString()
  ): Promise<string> {
    const reportId = nanoid(12);
    const filename = `report-${reportId}.md`;
    const filepath = join(this.outputDir, filename);

    const reportContent = `# ${title}

## 토론 요약
${summary}

## 참여자
${participants.join(', ')}

## 최종 결정
${finalDecision}

## 생성 정보
- 보고서 ID: ${reportId}
- 생성 시간: ${timestamp}
- 토론 ID: ${discussionId}

---

이 보고서는 NCO 시스템에서 자동 생성되었습니다.`;

    try {
      const stream = createWriteStream(filepath, { encoding: 'utf-8' });
      stream.write(reportContent);
      stream.end();

      await new Promise<void>((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      logger.info(`토론 보고서 생성됨: ${filepath}`);
      return filepath;
    } catch (error) {
      logger.error(`보고서 생성 실패: ${error.message}`);
      throw new Error(`보고서 생성 실패: ${error.message}`);
    }
  }
}

// 전역 인스턴스
export const reportGenerator = new ReportGenerator();

// 테스트용 함수
export const testReportGeneration = async (): Promise<string> => {
  return reportGenerator.generateReport(
    'test-discussion-123',
    '테스트 보고서: 자동 생성 테스트',
    '이 보고서는 테스트용으로 생성되었습니다.',
    ['claude-code', 'opencode', 'gemini-api'],
    '모든 팀원이 동의한 최종 결정입니다.',
    '2026-07-14T10:00:00Z'
  );
};

// 모듈 내보내기
export default reportGenerator;