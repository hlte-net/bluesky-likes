import { AtpAgent } from '@atproto/api';
import { input } from '@inquirer/prompts';
import { Redis } from 'ioredis';
import { webcrypto } from 'node:crypto';

const POLLING_FREQ_SECONDS = 67;
const REDIS_SET_NAME = "hlte:bluesky-likes:processed-uris";

// getKey, generateHmac & hlteFetch all ported with minimal change from:
// https://github.com/hlte-net/extension/blob/fdfa965c139e18237503bd79dfaca3122512af43/shared.js

async function getKey() {
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
const hlteFetch = async (uri: string, key: webcrypto.CryptoKey, payload = undefined, query = undefined) => {
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

async function login(agent: AtpAgent) {
  const params = {
    identifier: process.env.BLUESKY_IDENT as string,
    password: process.env.BLUESKY_PASS as string,
    authFactorToken: undefined
  };

  try {
    return await agent.login(params);
  } catch (e) {
    if (e.status === 401 && e.error === 'AuthFactorTokenRequired') {
      params.authFactorToken = await input({ message: 'Enter the auth code sent to you via email:' });
      return agent.login(params);
    }

    throw e;
  }
}

async function pollFeed(agent: AtpAgent, redis: Redis, key: webcrypto.CryptoKey, actor: string): Promise<void> {
  let allData = [];
  let cursor = undefined;
  while (true) {
    const { data } = await agent.getActorLikes({ actor, limit: 100, cursor });
    if (!data.feed.length) {
      break;
    }
    allData = allData.concat(data.feed);
    cursor = data.cursor;
  }

  const xformed = allData.map(({
    post: {
      uri,
      author: { handle, displayName },
      record,
      embed
    } }) => {
    const [, type, urlId] = uri.slice('at://'.length).split('/');

    if (type !== 'app.bsky.feed.post') {
      throw new Error(`wtf is this? ${type} ${uri}`);
    }

    return {
      uri, handle, displayName, text: (record as any).text, embed,
      userUrl: `https://bsky.app/profile/${handle}/post/${urlId}`,
    }
  });

  let newEntries = 0;
  for (const entry of xformed) {
    if (!(await redis.sismember(REDIS_SET_NAME, entry.uri))) {
      const { userUrl, text, handle, displayName } = entry;
      const payload = {
        uri: userUrl,
        data: `${text}\n\n-- @${handle}, ${displayName}`,
        // why aren't annotations showing up in the DB?!?
        annotation: `<from bluesky-likes at ${new Date().toLocaleString()}>`,
        // secondaryURI should be image if available in entry.embed!
      };

      const response = await hlteFetch(process.env.HLTE_USER_URL, key, payload);

      if (response.status !== 204) {
        console.error(response);
        throw new Error(`bad hlte fetch: ${response.status} ${response.statusText}`);
      }

      await redis.sadd(REDIS_SET_NAME, entry.uri);
      newEntries++;
      console.log(`Added ${userUrl}`);
    }
  }

  if (newEntries) {
    console.log(`Processed ${newEntries} new likes`);
  }
}

async function main() {
  const key = await getKey();
  const redis = new Redis(process.env.REDIS_URL);
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  const { data: { handle } } = await login(agent);
  const { data: { did } } = await agent.resolveHandle({ handle });
  console.log(`Logged in succesfully as @${handle} (${did})`);

  let pollFeedHandle: NodeJS.Timeout, resolver: Function;

  ['SIGINT', 'SIGHUP', 'SIGTERM'].forEach((signal) => process.on(signal, (sig) => {
    console.log('signaled!', sig, pollFeedHandle, resolver)
    redis.disconnect();
    clearTimeout(pollFeedHandle);
    resolver((pollFeedHandle = null));
  }));

  do {
    await new Promise((resolve) => {
      resolver = resolve;
      pollFeed(agent, redis, key, did)
        .then(() => setTimeout(() => resolve(true), POLLING_FREQ_SECONDS * 1000))
        .then(timeoutHandle => (pollFeedHandle = timeoutHandle))
        .catch((error) => {
          console.log(`pollFeed errored: ${error}`);
          console.error(error);
        })
    });
  } while (pollFeedHandle);
}

main();
