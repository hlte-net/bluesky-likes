import { webcrypto } from 'node:crypto';

export type HLTEPostPayload = {
  uri: string,
  data: string,
  annotation?: string,
  secondaryURI?: string,
};

// getKey, generateHmac & hlteFetch all ported with minimal change from:
// https://github.com/hlte-net/extension/blob/fdfa965c139e18237503bd79dfaca3122512af43/shared.js

export async function getKey() {
  const keyStr = process.env.HLTE_USER_KEY;
  const octetLen = keyStr.length / 2;

  if (keyStr.length % 2) {
    throw new Error('odd key length!');
  }

  // try to parse as an bigint, if it fails then it's not a number
  BigInt(`0x${keyStr}`);

  const keyBuf = [...keyStr.matchAll(/[a-fA-F0-9]{2}/ig)]
    .reduce((ab, x, i) => {
      ab[i] = Number.parseInt(x as any, 16);
      return ab;
    }, new Uint8Array(octetLen));

  return webcrypto.subtle.importKey(
    'raw',
    keyBuf,
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );
}

async function generateHmac(key: webcrypto.CryptoKey, payloadStr: string) {
  const digest = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadStr));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0')).join('');
};

const PP_HDR = 'x-hlte';
const protectEndpointQses = ['/search'];
export async function hlteFetch(uri: string, key: webcrypto.CryptoKey, payload = undefined, query = undefined) {
  const protectedEp = payload || protectEndpointQses.includes(new URL(uri).pathname);
  let opts = { headers: {}, cache: undefined, method: undefined, body: undefined };
  let params = new URLSearchParams();

  if (query) {
    // the timestamp we add here is not consumed by the backend: rather, it's used
    // simply to add entropy to the query string when it is HMACed
    if (protectedEp) {
      query['ts'] = Number(new Date());
    }

    params = new URLSearchParams(query);

    if (params.toString().length) {
      uri += `?${params.toString()}`;
    }
  }

  if (payload) {
    opts = {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Request-Headers': PP_HDR
      },
      method: 'POST',
      body: JSON.stringify(payload),
    };
  }

  if (protectedEp) {
    opts.headers[PP_HDR] = await generateHmac(key, payload ? opts.body : params.toString());
  }

  return fetch(uri, opts);
};
