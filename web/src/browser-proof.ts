// The private key is stored as a nonextractable CryptoKey, never as a secret string.
// This prevents a copied session cookie alone from authenticating another client;
// same-origin scripts or malware controlling this browser can still ask it to sign.
type BrowserKey = { privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JsonWebKey };
const databaseName = 'crm-browser-security';
const storeName = 'keys';
const keyName = 'session-signing-v1';
let keyPromise: Promise<BrowserKey | undefined> | undefined;
let binding: string | undefined;
let clockOffset = 0;
let bindingPromise: Promise<string> | undefined;
let generation = 0;

export class BrowserProofError extends Error {
  readonly status = 401;
  constructor(public readonly code: string, message: string) { super(message); }
}

function unavailable() {
  return new BrowserProofError('browser_key_unavailable', 'Không truy cập được khóa bảo mật trình duyệt. Hãy dùng HTTPS và đăng nhập lại trên trình duyệt này.');
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) throw unavailable();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(unavailable());
    request.onblocked = () => reject(unavailable());
  });
}

function validKey(value: BrowserKey | undefined): value is BrowserKey {
  return Boolean(value?.privateKey?.type === 'private' && !value.privateKey.extractable &&
    value.privateKey.algorithm.name === 'ECDSA' && (value.privateKey.algorithm as EcKeyAlgorithm).namedCurve === 'P-256' &&
    value.privateKey.usages.includes('sign') && value.publicJwk?.kty === 'EC' && value.publicJwk.crv === 'P-256' &&
    value.publicJwk.x && value.publicJwk.y && !value.publicJwk.d);
}

async function storedKey(create: boolean): Promise<BrowserKey | undefined> {
  const db = await openDatabase();
  try {
    const read = await new Promise<BrowserKey | undefined>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(keyName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(unavailable());
    });
    if (read) {
      if (!validKey(read)) throw unavailable();
      return read;
    }
    if (!create) return undefined;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const candidate: BrowserKey = { ...pair, publicJwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y } };
    // A readwrite transaction serializes this compare-and-create across tabs.
    return await new Promise<BrowserKey>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.get(keyName);
      let winner: BrowserKey;
      request.onsuccess = () => {
        winner = request.result ?? candidate;
        if (!validKey(winner)) { transaction.abort(); return; }
        if (!request.result) store.add(candidate, keyName);
      };
      transaction.oncomplete = () => resolve(winner);
      transaction.onerror = transaction.onabort = () => reject(unavailable());
    });
  } finally { db.close(); }
}

async function getKey(create = false): Promise<BrowserKey | undefined> {
  keyPromise ??= storedKey(create).catch(error => { keyPromise = undefined; throw error; });
  const key = await keyPromise;
  if (!key && create) {
    keyPromise = undefined;
    return getKey(true);
  }
  return key;
}

/** Only the password login flow may create a new browser key. */
export async function prepareBrowserLogin(): Promise<JsonWebKey> {
  const key = await getKey(true);
  if (!key) throw unavailable();
  return key.publicJwk;
}

export function setBrowserSession(value?: { browser_binding?: string; server_time?: number } | null) {
  generation++;
  binding = value?.browser_binding;
  if (typeof value?.server_time === 'number') clockOffset = value.server_time - Date.now();
  bindingPromise = undefined;
}

/** An in-flight response may only affect the local session that sent it. */
export function getBrowserSessionGeneration(): number {
  return generation;
}

async function getBinding(signal?: AbortSignal): Promise<string> {
  if (binding) return binding;
  bindingPromise ??= (async () => {
    const revision = generation;
    const response = await fetch('/api/crm/session/bootstrap', { credentials: 'same-origin', cache: 'no-store', signal });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new BrowserProofError(value?.error?.code ?? 'session_required', value?.error?.message ?? 'Vui lòng đăng nhập lại.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(value?.browser_binding) || !Number.isFinite(value?.server_time)) throw unavailable();
    if (revision !== generation) throw new BrowserProofError('browser_session_changed', 'Phiên đăng nhập đã thay đổi. Hãy thử lại.');
    binding = value.browser_binding;
    clockOffset = value.server_time - Date.now();
    return binding!;
  })().finally(() => { bindingPromise = undefined; });
  return bindingPromise;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function browserBodyHash(body = ''): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))));
}

export async function signBrowserRequest(target: string, method: string, body: string, headers: Headers, signal?: AbortSignal): Promise<string> {
  if (!await getKey()) throw new BrowserProofError('browser_key_missing', 'Cookie không đủ để đăng nhập trên trình duyệt này. Hãy nhập lại tài khoản và mật khẩu.');
  return signRequestWithBinding(target, method, body, headers, await getBinding(signal), clockOffset);
}

/** Pre-session OTP requests prove possession of the key used for the password step. */
export async function signBrowserChallengeRequest(target: string, method: string, body: string, headers: Headers, challengeId: string, offset = 0): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(challengeId)) throw new Error('Yêu cầu xác minh không hợp lệ. Hãy đăng nhập lại.');
  return signRequestWithBinding(target, method, body, headers, challengeId, offset);
}

async function signRequestWithBinding(target: string, method: string, body: string, headers: Headers, sid: string, offset: number): Promise<string> {
  const key = await getKey();
  if (!key) throw new BrowserProofError('browser_key_missing', 'Cookie không đủ để đăng nhập trên trình duyệt này. Hãy nhập lại tài khoản và mật khẩu.');
  const url = new URL(target, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/crm/')) throw new Error('Địa chỉ CRM không hợp lệ.');
  const header = encode({ alg: 'ES256', typ: 'crm-pop+jwt' });
  const payload = encode({
    aud: window.location.origin, htm: method.toUpperCase(), htu: url.pathname + url.search,
    bth: await browserBodyHash(body), sid, iat: Math.floor((Date.now() + offset) / 1000),
    jti: base64url(crypto.getRandomValues(new Uint8Array(24))), ikh: headers.get('Idempotency-Key') ?? '',
  });
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}
