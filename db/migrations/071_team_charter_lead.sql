-- 071: 조직 관리 주체 + 팀 상시 임무(charter)/리더
-- organizations.manager  — 이 조직을 관리하는 주체 (두뇌 세션, 예: claude-1)
-- teams.lead             — 팀 대표 워커 모델 (예: mlx, ollama)
-- teams.charter          — 팀 상시 임무. team-runner가 이 텍스트로 일일 태스크를 자동 디스패치한다.
ALTER TABLE organizations ADD COLUMN manager TEXT;
ALTER TABLE teams ADD COLUMN lead TEXT;
ALTER TABLE teams ADD COLUMN charter TEXT;
