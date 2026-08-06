import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  deriveDidFromPublicKey,
  generateRandomDid,
  signMessage,
  verifySignature,
  isValidDid,
} from './keyManager.js';

describe('generateKeyPair', () => {
  it('base64url 로 인코딩된 Ed25519 키페어를 낸다', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    // base64url 은 `+` `/` `=` 를 쓰지 않는다. 하나라도 섞이면 저장·전송 경로가 깨진다.
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // Ed25519 raw 공개키는 32바이트다.
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(32);
  });

  it('호출마다 다른 키가 나온다', async () => {
    const [a, b] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe('서명 · 검증 왕복', () => {
  it('자기 서명은 검증된다', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const sig = await signMessage(privateKey, '전송 승인');
    expect(await verifySignature(publicKey, '전송 승인', sig)).toBe(true);
  });

  it('메시지가 한 글자만 달라도 거부한다', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const sig = await signMessage(privateKey, '금액 100');
    expect(await verifySignature(publicKey, '금액 1000', sig)).toBe(false);
  });

  it('다른 키의 공개키로는 검증되지 않는다', async () => {
    const signer = await generateKeyPair();
    const other = await generateKeyPair();
    const sig = await signMessage(signer.privateKey, 'msg');
    expect(await verifySignature(other.publicKey, 'msg', sig)).toBe(false);
  });

  it('서명을 변조하면 거부한다', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const sig = await signMessage(privateKey, 'msg');
    const tampered = Buffer.from(sig, 'base64url');
    tampered[0] ^= 0xff;
    expect(await verifySignature(publicKey, 'msg', tampered.toString('base64url'))).toBe(false);
  });

  it('빈 메시지도 서명·검증된다', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    expect(await verifySignature(publicKey, '', await signMessage(privateKey, ''))).toBe(true);
  });

  it('유니코드를 UTF-8 로 다룬다 — 인코딩이 어긋나면 검증이 깨진다', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const msg = '한글 · emoji 🔐 · ünïcode';
    expect(await verifySignature(publicKey, msg, await signMessage(privateKey, msg))).toBe(true);
  });

  describe('verifySignature 는 던지지 않고 false 를 낸다', () => {
    // 검증 실패와 입력 오류가 예외로 갈리면 호출부가 try 를 빠뜨려 500 이 난다.
    // 어떤 쓰레기 입력이 와도 boolean 이어야 한다.
    it.each([
      ['공개키가 쓰레기', 'not-a-key'],
      ['공개키가 빈 문자열', ''],
      ['공개키 길이가 틀림', Buffer.alloc(31).toString('base64url')],
    ])('%s', async (_label, publicKey) => {
      await expect(verifySignature(publicKey, 'msg', 'AAAA')).resolves.toBe(false);
    });

    it('서명이 쓰레기여도 false', async () => {
      const { publicKey } = await generateKeyPair();
      await expect(verifySignature(publicKey, 'msg', 'zzzz')).resolves.toBe(false);
      await expect(verifySignature(publicKey, 'msg', '')).resolves.toBe(false);
    });
  });

  it('signMessage 는 잘못된 개인키에 대해 던진다 — 조용히 성공하지 않는다', async () => {
    // 서명 쪽은 실패를 삼키면 안 된다. 빈 서명을 만들어 내보내면 하류에서 위조로 보인다.
    await expect(signMessage('not-a-key', 'msg')).rejects.toThrow();
  });
});

describe('deriveDidFromPublicKey', () => {
  it('did:nova: 접두사 + 32자 hex', () => {
    const did = deriveDidFromPublicKey('somekey');
    expect(did).toMatch(/^did:nova:[0-9a-f]{32}$/);
  });

  it('결정적이다 — 같은 공개키는 같은 DID', () => {
    expect(deriveDidFromPublicKey('k')).toBe(deriveDidFromPublicKey('k'));
  });

  it('공개키가 다르면 DID 도 다르다', () => {
    expect(deriveDidFromPublicKey('k1')).not.toBe(deriveDidFromPublicKey('k2'));
  });

  it('생성한 DID 는 형식 검증을 통과한다', async () => {
    const { publicKey } = await generateKeyPair();
    expect(isValidDid(deriveDidFromPublicKey(publicKey))).toBe(true);
  });
});

describe('generateRandomDid', () => {
  it('did:nova: + 32자 hex', () => {
    expect(generateRandomDid()).toMatch(/^did:nova:[0-9a-f]{32}$/);
  });

  it('충돌하지 않는다 — 500개 전부 고유', () => {
    expect(new Set(Array.from({ length: 500 }, generateRandomDid)).size).toBe(500);
  });

  it('형식 검증을 통과한다', () => {
    expect(isValidDid(generateRandomDid())).toBe(true);
  });
});

describe('isValidDid', () => {
  it.each([
    'did:nova:abc123',
    'did:nova:official-treasury',
    'did:nova:under_score',
    'did:nova:a',
    `did:nova:${'a'.repeat(128)}`,
  ])('허용: %s', (did) => {
    expect(isValidDid(did)).toBe(true);
  });

  it.each([
    ['빈 id', 'did:nova:'],
    ['128자 초과', `did:nova:${'a'.repeat(129)}`],
    ['다른 method', 'did:web:example.com'],
    ['접두사 없음', 'nova:abc'],
    ['빈 문자열', ''],
    ['콜론 포함', 'did:nova:a:b'],
    ['공백 포함', 'did:nova:a b'],
    ['점 포함', 'did:nova:a.b'],
    ['앞에 군더더기', 'xdid:nova:abc'],
    ['뒤에 군더더기', 'did:nova:abc!'],
    ['개행으로 우회 시도', 'did:nova:abc\nevil'],
  ])('거부: %s', (_label, did) => {
    expect(isValidDid(did)).toBe(false);
  });
});
