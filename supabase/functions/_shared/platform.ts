const encoder = new TextEncoder();
const lifetime = 3600;
const purpose = 'devweek-platform-access';

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
async function key(secret: string) {
  return await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export function platformTokens(secret: string, now = () => Math.floor(Date.now() / 1000)) {
  if (encoder.encode(secret).length < 32) throw new Error('Signing secret must have at least 32 bytes');
  const signingKey = key(secret);
  return {
    async issue() {
      const issued = now();
      const payload = encode(encoder.encode(JSON.stringify({ purpose, iat: issued, exp: issued + lifetime, nonce: crypto.randomUUID() })));
      const message = `v1.${payload}`;
      const signature = await crypto.subtle.sign('HMAC', await signingKey, encoder.encode(message));
      return { access_token: `${message}.${encode(new Uint8Array(signature))}`, token_type: 'Bearer', expires_in: lifetime };
    },
    async verify(token: string): Promise<boolean> {
      try {
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== 'v1') return false;
        const valid = await crypto.subtle.verify('HMAC', await signingKey, decode(parts[2]), encoder.encode(`v1.${parts[1]}`));
        if (!valid) return false;
        const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
        return claims.purpose === purpose && Number.isInteger(claims.iat) && Number.isInteger(claims.exp)
          && claims.iat <= now() && claims.exp > now() && claims.exp - claims.iat === lifetime
          && typeof claims.nonce === 'string';
      } catch { return false; }
    },
    async matchesCode(supplied: string, expected: string): Promise<boolean> {
      // Web Crypto performs signature verification; no direct secret-string comparison.
      const signature = await crypto.subtle.sign('HMAC', await signingKey, encoder.encode(expected));
      return await crypto.subtle.verify('HMAC', await signingKey, signature, encoder.encode(supplied));
    },
  };
}
