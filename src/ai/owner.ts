// The private JWK is read and used only on this device. Send a challenge signature, never the key.
export async function signInOwner(file: File) {
  if (file.size > 4096) throw new Error('Choose the owner key JSON file.');
  const jwk = JSON.parse(await file.text()) as JsonWebKey;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d)
    throw new Error('Choose the owner private key JSON file.');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const challengeResponse = await fetch('/api/owner/challenge', { cache: 'no-store' });
  const challengeBody = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error(challengeBody.error || 'Owner login is unavailable.');
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode('pdf-owner-login-v1:' + challengeBody.challenge),
    ),
  );
  const response = await fetch('/api/owner/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge: challengeBody.challenge,
      signature: btoa(String.fromCharCode(...signature))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Owner login failed.');
}
