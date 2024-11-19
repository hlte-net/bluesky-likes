import { AtpAgent, ComAtprotoServerCreateSession, AtpSessionEvent, AtpSessionData } from '@atproto/api';
import { input } from '@inquirer/prompts';
import { Redis } from 'ioredis';
import { webcrypto } from 'node:crypto';
import { writeFile } from 'fs/promises';
import { getKey, hlteFetch, HLTEPostPayload } from './hlte';
import logger from './logger';
logger('bluesky-likes');

const POLLING_FREQ_SECONDS = Number.parseInt(process.env.BSKYHLTE_POLLING_FREQ_SECONDS ?? '67');
const REDIS_SET_NAME = "hlte:bluesky-likes:processed-uris";
const REDIS_SESSION_NAME = "hlte:bluesky-likes:saved-session";

async function login(agent: AtpAgent, redis: Redis): Promise<string> {
  async function loginImpl(): Promise<ComAtprotoServerCreateSession.Response> {
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

  console.log(`Authenticating as @${process.env.BLUESKY_IDENT}...`);
  const savedSession = await redis.get(REDIS_SESSION_NAME);
  if (savedSession) {
    try {
      console.log('Reusing saved session...');
      const { data: { handle } } = await agent.resumeSession(JSON.parse(savedSession));
      return handle;
    } catch (e) {
      console.error('resumeSession failed!', e);
      await redis.del(REDIS_SESSION_NAME);
    }
  }

  const response = await loginImpl();
  console.log(`${response.headers['ratelimit-remaining']} logins remain in the next ` +
    `${Number(waitMins(response.headers) / 24).toFixed(1)} hours.`);
  await redis.set(REDIS_SESSION_NAME, JSON.stringify(response.data));
  return response.data.handle;
}

async function pollFeed(agent: AtpAgent, redis: Redis, key: webcrypto.CryptoKey, actor: string): Promise<void> {
  let allData = [];
  let cursor = undefined;
  while (true) {
    const { data } = await agent.getActorLikes({ actor, limit: 100, cursor });

    if (!data.feed.length) {
      break;
    }

    if (data.feed.length < 100) {
      console.debug(`Page had less (${data.feed.length}) than expected!`);
    }

    allData = allData.concat(data.feed);
    cursor = data.cursor;
    console.debug(`Getting next page at cursor ${cursor}`);
  }

  if (process.env.BSKYHLTE_DUMP_FEED) {
    // purposefully don't await (best effort)
    writeFile("last_feed.json", JSON.stringify(allData, null, 2));
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
      throw new Error(`Unknown post type "${type}" for ${uri}`);
    }

    let embedImages = [];
    let embedText;
    let embedRecords = [];
    if (record?.embed?.['$type'] === 'app.bsky.embed.images' && embed['$type'] === 'app.bsky.embed.images#view') {
      embedImages = embed.images.map(({ fullsize }) => fullsize);
      embedText = embed.text;
    }
    else if (record?.embed?.['$type'] === 'app.bsky.embed.record' && embed['$type'] === 'app.bsky.embed.record#view') {
      const { handle, displayName } = embed.record.author ?? embed.record.creator;
      const createdAt = embed.record.value?.createdAt ?? embed.record.record?.createdAt;
      const text = embed.record.value?.text ?? embed.record.record?.description;
      embedRecords.push(`"${text}" -- @${handle} / ${displayName} at ${createdAt}`);
    }

    return {
      uri, handle, displayName, text: (record as any).text,
      embed, embedImages, embedText, embedRecords,
      createdAt: (record as any).createdAt,
      userUrl: `https://bsky.app/profile/${handle}/post/${urlId}`,
    }
  });

  console.debug(`Full likes feed has ${allData.length} entries`);

  let newEntries = 0;
  for (const entry of xformed) {
    if (!(await redis.sismember(REDIS_SET_NAME, entry.uri))) {
      const { userUrl, text, handle, displayName, createdAt,
        embedImages, embedText, embedRecords } = entry;
      const payload: HLTEPostPayload = {
        uri: userUrl,
        data: `${text}\n\n-- @${handle} / ${displayName}`,
        annotation: `(from bluesky-likes, original post made at ${createdAt})\n`,
      };

      if (embedImages.length) {
        const [picked, ...rest] = embedImages;
        payload.secondaryURI = picked;
        if (embedText) {
          payload.annotation += `\nEmbed text:\n"${embedText}"\n`;
        }
        if (rest.length) {
          payload.annotation += `\nRemaining image embeds:\n${rest.join('\n')}\n`;
        }
      }

      if (embedRecords.length) {
        payload.annotation += `\nReposting:\n\n${embedRecords.join('\n---\n')}\n`;
      }

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

const waitMins = (headers: { [key: string]: string }): number =>
  Number(((Number.parseInt(headers['ratelimit-reset']) * 1000) - Number(new Date())) / 1000 / 60);

async function agentSessionWasRefreshed(redis: Redis, event: AtpSessionEvent, session: AtpSessionData | undefined) {
  if (event === 'update') {
    if (!session) {
      console.error(`Update event but no session!`);
      return;
    }

    await redis.set(REDIS_SESSION_NAME, JSON.stringify(session));
    console.log('Session updated & saved');
  }
}

async function main() {
  let pollFeedHandle: NodeJS.Timeout;
  let resolver = (_) => { };
  let handle: string;
  const key = await getKey();
  const redis = new Redis(process.env.REDIS_URL);
  const agent = new AtpAgent({
    service: 'https://bsky.social',
    persistSession: agentSessionWasRefreshed.bind(null, redis),
  });

  function shutdown() {
    console.log('Ending...');
    redis.disconnect();
    clearTimeout(pollFeedHandle);
    resolver((pollFeedHandle = null));
    console.log('Done.');
  }

  try {
    handle = await login(agent, redis);
  } catch (e) {
    if (e.status === 429 && e.error === 'RateLimitExceeded') {
      console.error(`Login rate limit reached! Wait at least ${waitMins(e.headers).toFixed(0)} minutes before trying again.`);
      return shutdown();
    }

    throw e;
  }

  const { data: { did } } = await agent.resolveHandle({ handle });
  console.log(`Logged in succesfully as @${handle} (${did})`);

  ['SIGINT', 'SIGHUP', 'SIGTERM'].forEach((signal) => process.on(signal, shutdown));

  do {
    await new Promise((resolve) => {
      resolver = resolve;
      console.debug('Waking up...');
      pollFeed(agent, redis, key, did)
        .then(() => setTimeout(() => resolve(true), POLLING_FREQ_SECONDS * 1000))
        .then(timeoutHandle => (pollFeedHandle = timeoutHandle))
        .catch((error) => {
          console.error(`pollFeed errored: ${error}`);
          console.error(error);
        })
    });
  } while (pollFeedHandle);
}

main();
