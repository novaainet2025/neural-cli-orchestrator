const INPUT_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'switch', 'slider',
])

const DESTRUCTIVE_LABEL_RE =
  /(삭제|제거|지우|영구|탈퇴|해지|로그아웃|결제|주문|구매|송금|전송|보내기|발행|게시|취소|비활성|delete|remove|discard|erase|pay|buy|checkout|order|purchase|send|publish|logout|sign\s?out|unsubscribe|deactivate|destroy|wipe)/i

const clip = (value, limit = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)

/**
 * Frozen model of nova-use's current pageDigestFromSnapshot contract.
 * It intentionally stays shallow so the A/B benchmark can measure the added
 * P1-P4 contract without touching nova-use's dirty working tree.
 */
export function baselineDigest(snapshot) {
  const normalized = snapshot.refs.map((item) => ({ ...item, role: item.role.toLowerCase() }))
  const fields = normalized
    .filter((item) => INPUT_ROLES.has(item.role))
    .slice(0, 6)
    .map((item) => ({
      ...(item.name ? { label: item.name.slice(0, 160) } : {}),
      type: item.role,
      selector: item.ref,
    }))
  const button = normalized.find((item) => item.role === 'button' && item.name)
  const link = normalized.find((item) => item.role === 'link' && item.name)
  const searchable =
    `${snapshot.title} ${snapshot.url} ${normalized.slice(0, 100).map((item) => item.name).join(' ')}`.toLowerCase()
  const purpose = /login|log in|sign in|로그인/.test(searchable) ? '로그인'
    : /checkout|payment|결제|주문/.test(searchable) ? '결제'
      : /search|검색/.test(searchable) ? '검색'
        : fields.length > 0 ? '폼 입력' : undefined
  const progressMatch = searchable.match(/(?:step\s*)?(\d{1,3})\s*(?:\/|of)\s*(\d{1,3})/i)
  const next = button ?? link

  return {
    title: snapshot.title,
    url: snapshot.url,
    counts: {
      forms: normalized.filter((item) => item.role === 'form').length,
      inputs: normalized.filter((item) => INPUT_ROLES.has(item.role)).length,
      buttons: normalized.filter((item) => item.role === 'button').length,
      links: normalized.filter((item) => item.role === 'link').length,
    },
    ...(purpose ? { purpose } : {}),
    ...(progressMatch ? { progress: `${progressMatch[1]}/${progressMatch[2]}` } : {}),
    ...(next ? { nextAction: `${next.name.slice(0, 160)} (${next.ref})` } : {}),
    fields,
  }
}

function taskTypeOf(searchable, normalized) {
  if (/quiz|객관식|문제|정답/.test(searchable)) return 'quiz'
  if (/login|log in|sign in|로그인/.test(searchable)) return 'login'
  if (/signup|sign up|create account|회원가입/.test(searchable)) return 'signup'
  if (/checkout|payment|pay now|결제|주문/.test(searchable)) return 'checkout'
  if (/search|검색/.test(searchable)) return 'search'
  if (/survey|설문/.test(searchable)) return 'form'
  if (normalized.some((item) => INPUT_ROLES.has(item.role))) return 'form'
  if (normalized.filter((item) => item.role === 'link').length >= 3) return 'list'
  return 'generic'
}

function intentOf(item) {
  const label = item.name.toLowerCase()
  if (/upload|attach|첨부|업로드/.test(label)) return 'upload'
  if (item.role === 'searchbox' || /search|검색/.test(label)) return 'search'
  if (['textbox', 'spinbutton', 'slider'].includes(item.role)) return 'input'
  if (['combobox', 'listbox', 'option', 'radio'].includes(item.role)) return 'select'
  if (['checkbox', 'switch'].includes(item.role)) return 'toggle'
  if (item.role === 'link') return 'navigate'
  if (item.role === 'menuitem' || /menu|메뉴/.test(label)) return 'menu'
  if (/expand|펼치/.test(label)) return 'expand'
  if (/dismiss|close|닫기/.test(label)) return 'dismiss'
  if (/edit|편집|수정/.test(label)) return 'edit'
  if (item.role === 'button' && /submit|continue|next|sign in|create|pay|send|publish|delete|제출|다음|결제|전송|게시|삭제/.test(label)) {
    return 'submit'
  }
  return 'action'
}

function primaryCtaOf(normalized) {
  const buttons = normalized.filter((item) => item.role === 'button' && item.name)
  let best = null
  let bestScore = -1
  for (const button of buttons) {
    const label = button.name.toLowerCase()
    let score = 1
    if (/submit|continue|next|sign in|create|pay|send|publish|delete|제출|다음|결제|전송|게시|삭제/.test(label)) score += 4
    if (/cancel|back|취소|뒤로/.test(label)) score -= 2
    if (score > bestScore) {
      best = button
      bestScore = score
    }
  }
  return best
}

function playbookFor(taskType) {
  switch (taskType) {
    case 'quiz': return ['질문과 보기를 비교', '보기 하나를 선택', '변화를 검증하고 다음 문항 진행']
    case 'login': return ['계정 식별자와 비밀번호 입력', '로그인 실행', '로그인 결과 검증']
    case 'signup': return ['필수 필드를 입력', '가입 실행 전 조건 확인', '가입 결과 검증']
    case 'search': return ['검색어 입력', '검색 실행', '결과 목록 확인']
    case 'checkout': return ['필수 정보를 확인', '결제 직전 사용자 동의', '동의 후 실행 결과 검증']
    case 'form': return ['필수 필드 입력', '검증 오류 확인', '제출 후 결과 검증']
    case 'list': return ['목록 항목 파악', '목표와 맞는 항목 선택', '상세 화면 확인']
    default: return ['상호작용 요소 파악', '안전한 다음 행동 선택', '실행 결과 검증']
  }
}

function autoMissionFor(taskType, primary) {
  const byType = {
    quiz: '문제를 읽고 보기 하나를 선택해 다음 문항으로 진행',
    login: '필수 계정 정보를 입력해 로그인',
    signup: '필수 정보를 입력해 계정 생성 준비',
    search: '검색어를 입력해 관련 결과 확인',
    checkout: '주문 정보를 확인하고 사용자 동의 전까지 결제 준비',
    form: '필수 입력을 채워 제출 준비',
    list: '목록에서 목표와 관련된 항목 탐색',
  }
  return byType[taskType] ?? (primary ? `'${clip(primary.name)}' 작업 준비` : '페이지의 주요 내용을 확인')
}

/**
 * Electron-side candidate: it consumes nova-use's existing sanitized ref
 * snapshot. It does not inject a content script, call chrome.*, or recreate the
 * ref/CDP/capture/policy pipelines.
 */
export function candidateDigest(snapshot) {
  const legacy = baselineDigest(snapshot)
  const normalized = snapshot.refs
    .map((item) => ({ ...item, role: item.role.toLowerCase(), name: clip(item.name) }))
    .slice(0, 500)
  const searchable =
    `${snapshot.title} ${snapshot.url} ${normalized.slice(0, 100).map((item) => item.name).join(' ')}`.toLowerCase()
  const taskType = taskTypeOf(searchable, normalized)
  const primary = primaryCtaOf(normalized)
  const affordances = normalized
    .filter((item) => item.ref && item.name && (
      INPUT_ROLES.has(item.role)
      || ['button', 'link', 'menuitem', 'option', 'listbox', 'tab'].includes(item.role)
    ))
    .slice(0, 100)
    .map((item) => ({
      intent: intentOf(item),
      label: item.name,
      ref: item.ref,
      selector: item.ref,
      destructive: DESTRUCTIVE_LABEL_RE.test(item.name),
    }))
  const requiredRoles = new Set(['login', 'signup'])
  const requiredInputs = normalized
    .filter((item) => ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(item.role))
    .filter((item) => requiredRoles.has(taskType) || /\*|required|필수/i.test(item.name))
    .slice(0, 15)
    .map((item) => ({ label: item.name, selector: item.ref, filled: false }))
  const blockingIssues = requiredInputs.map((item) => `필수 미입력: ${item.label}`)
  const destructivePrimary = Boolean(primary && DESTRUCTIVE_LABEL_RE.test(primary.name))
  const safeToAutostart = !(destructivePrimary && blockingIssues.length === 0)
  const nextAction = blockingIssues.length > 0
    ? `'${requiredInputs[0].label}' 필드에 값 입력`
    : primary
      ? `'${primary.name}' 버튼 클릭`
      : '주요 상호작용 요소 확인 후 진행'

  return {
    ...legacy,
    affordances,
    comprehension: {
      userGoal: autoMissionFor(taskType, primary),
      requestedFromUser: requiredInputs.map((item) => `${item.label} 입력`),
      primaryCta: primary
        ? { text: primary.name, selector: primary.ref, disabled: false }
        : null,
      requiredInputs,
      blockingIssues,
      nextAction,
      taskType,
      playbook: playbookFor(taskType),
      autoMission: autoMissionFor(taskType, primary),
      safeToAutostart,
    },
  }
}

const mask = (value) => clip(value, 512)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
  .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, '<api-key>')
  .replace(/\b(api[-_ ]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=<secret>')

const domainOf = (value) => {
  try { return new URL(value).hostname.toLowerCase() } catch { return mask(value).toLowerCase() }
}

export class LearningPrototype {
  constructor(maxRecords = 500) {
    this.maxRecords = maxRecords
    this.records = []
  }

  append(record) {
    this.records.push(record)
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords)
    return record
  }

  recordAction({ pageSignature, action, domain, selector, frame = 0, success, strategy = '' }) {
    return this.append({
      kind: 'action',
      pageSignature: mask(pageSignature),
      action: mask(action),
      domain: domainOf(domain),
      selector: mask(selector),
      frame: Number.isInteger(frame) ? frame : 0,
      success: Boolean(success),
      strategy: mask(strategy),
    })
  }

  lesson({ domain, goal, note }) {
    return this.append({ kind: 'lesson', domain: domainOf(domain), goal: mask(goal), note: mask(note) })
  }

  done({ domain, goal, evidence }) {
    return this.append({ kind: 'done', domain: domainOf(domain), goal: mask(goal), evidence: mask(evidence) })
  }

  isRepeatedFailure({ pageSignature, action, selector, frame = 0 }) {
    const expected = {
      pageSignature: mask(pageSignature),
      action: mask(action),
      selector: mask(selector),
      frame: Number.isInteger(frame) ? frame : 0,
    }
    return this.records.some((record) => record.kind === 'action'
      && record.success === false
      && record.pageSignature === expected.pageSignature
      && record.action === expected.action
      && record.selector === expected.selector
      && record.frame === expected.frame)
  }

  recall(goal, domain) {
    const hostname = domainOf(domain)
    const goalToken = mask(goal).toLowerCase()
    const matching = this.records.filter((record) => record.domain === hostname)
    return {
      goal: goalToken,
      successfulRoutines: matching.filter((record) => record.kind === 'action' && record.success),
      failures: matching.filter((record) => record.kind === 'action' && !record.success),
      lessons: matching.filter((record) => record.kind === 'lesson'),
      completions: matching.filter((record) => record.kind === 'done'),
    }
  }
}

export function baselineForceLadder(attempts) {
  const tried = []
  for (const attempt of attempts) {
    tried.push(attempt.strategy)
    if (attempt.dispatched) return { ok: true, tried, strategy: attempt.strategy, verified: false }
  }
  return { ok: false, tried, error: 'dispatch_failed' }
}

export function candidateForceLadder(attempts) {
  const tried = []
  for (const attempt of attempts) {
    tried.push(attempt.strategy)
    if (attempt.dispatched && attempt.targetEffect) {
      return { ok: true, tried, strategy: attempt.strategy, verified: true }
    }
  }
  return {
    ok: false,
    tried,
    verified: false,
    escalate: 'cdp',
    error: 'no_effect_after_dom_ladder',
  }
}
