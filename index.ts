import { AtpAgent, ComAtprotoServerCreateSession, AtpSessionEvent, AtpSessionData } from '@atproto/api';
import { input } from '@inquirer/prompts';
import { Redis } from 'ioredis';
import { webcrypto } from 'node:crypto';
import { writeFile } from 'fs/promises';
import { importKeyFromHexString, hlteFetch } from 'hlte-fetch';
import logger from './logger';

const IDENT = process.env.BLUESKY_IDENT;
const START_TS = Date.now();
logger(`bluesky-likes_${IDENT}`);

const POLLING_FREQ_SECONDS = Number.parseInt(process.env.BSKYHLTE_POLLING_FREQ_SECONDS ?? '67');
const THREAD_MAX_FETCH_DEPTH = Number.parseInt(process.env.BSKYHLTE_THREAD_MAX_FETCH_DEPTH ?? '100');
const REDIS_SET_NAME = `hlte:bluesky-likes:${IDENT}:processed-uris`;
const REDIS_SESSION_NAME = `hlte:bluesky-likes:${IDENT}:saved-session`;

type HLTEPostPayload = {
  uri: string,
  data: string,
  annotation?: string,
  secondaryURI?: string,
};

async function login(agent: AtpAgent, redis: Redis): Promise<string> {
  async function loginImpl(): Promise<ComAtprotoServerCreateSession.Response> {
    const params = {
      identifier: IDENT as string,
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

  console.log(`Authenticating as @${IDENT}...`);
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

function transformSingle({
  post: {
    uri,
    author: { handle, displayName },
    record,
    embed,
    replyCount,
  } }) {
  const [, type, urlId] = uri.slice('at://'.length).split('/');

  if (type !== 'app.bsky.feed.post') {
    throw new Error(`Unknown post type "${type}" for ${uri}`);
  }

  let embedImages = [];
  let embedText;
  let embedRecords = [];
  const recEmbType = record?.embed?.['$type'];

  if (!embed?.record?.notFound) {
    if (recEmbType === 'app.bsky.embed.images' && embed['$type'] === 'app.bsky.embed.images#view') {
      embedImages = embed.images.map(({ fullsize }) => fullsize);
      embedText = embed.text + '\nAlt texts: "' + embed.images.map(({ alt }) => alt).join('", "');
    }

    if (recEmbType === 'app.bsky.embed.recordWithMedia' && embed['$type'] === 'app.bsky.embed.recordWithMedia#view') {
      if (embed.media['$type'] === 'app.bsky.embed.external#view') {
        const { description, thumb } = embed.media.external;
        embedImages = [thumb];
        embedText = description;
      }
      else {
        embedImages = embed.media.images?.map(({ fullsize }) => fullsize);
        embedText = record.embed.media.images?.[0].alt ?? "";
      }
    }

    if ((recEmbType === 'app.bsky.embed.record' && embed['$type'] === 'app.bsky.embed.record#view') ||
      (recEmbType === 'app.bsky.embed.recordWithMedia' && embed['$type'] === 'app.bsky.embed.recordWithMedia#view')) {
      const { handle, displayName } = (embed.record.author ?? embed.record.record?.author) ?? embed.record.creator;
      const createdAt = embed.record.value?.createdAt ?? (embed.record.record?.createdAt ?? embed.record.record?.value?.createdAt);
      const text = (embed.record.value?.text ?? embed.record?.record?.value?.text) ?? embed.record.record?.description;
      embedRecords.push(`"${text}" -- @${handle} / ${displayName} at ${createdAt}`);

      if (embed.record.embeds?.length) {
        embedImages = embed.record.embeds.reduce((a, { images }) =>
          ([...a, ...(images?.map(({ fullsize }) => fullsize) ?? [])]), []);
      }
    }

    if (recEmbType === 'app.bsky.embed.external' && embed['$type'] === 'app.bsky.embed.external#view') {
      const { title, description } = embed.external;
      embedRecords.push(`"'${title}' -- ${description}" -- @${handle} / ${displayName} at ${record.createdAt}`);
    }

    if (recEmbType === 'app.bsky.embed.video' && embed['$type'] === 'app.bsky.embed.video#view') {
      embedImages = [embed.thumbnail];
    }
  } 

  return {
    uri, handle, displayName, text: (record as any).text,
    embed, embedImages, embedText, embedRecords,
    createdAt: (record as any).createdAt, replyCount,
    userUrl: `https://bsky.app/profile/${handle}/post/${urlId}`,
  }
}

function transformFeed(allData) {
  return allData.map(transformSingle);
}

function repliesFromAuthor(postObj) {
  const { post, replies } = postObj;
  let returnReplies = [];
  const authorsChildren = replies.filter((fPost) => fPost?.author?.did === post?.author?.did);

  for (const aChild of authorsChildren) {
    returnReplies = [...returnReplies, aChild.post.record];
    if (aChild.replies?.length) {
      returnReplies = returnReplies.concat(repliesFromAuthor(aChild));
    }
  }

  return returnReplies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function processThread(threadDataObj) {
  return repliesFromAuthor(threadDataObj.thread);
}

async function pollFeed(agent: AtpAgent, redis: Redis, key: webcrypto.CryptoKey, actor: string, actorHandle: string): Promise<void> {
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
    writeFile(`last-feed_${actorHandle}.json`, JSON.stringify(allData, null, 2));
  }

  const xformed = transformFeed(allData);
  console.debug(`Full likes feed has ${allData.length} entries`);

  for (const entry of xformed) {
    if (!(await redis.sismember(REDIS_SET_NAME, entry.uri))) {
      const { uri, userUrl, text, handle, displayName, createdAt,
        embedImages, embedText, embedRecords, replyCount } = entry;

      const payload: HLTEPostPayload = {
        uri: userUrl,
        data: `${text}\n\n-- @${handle} / ${displayName}`,
        annotation: `(from @${actorHandle}'s bluesky-likes, original post made at ${createdAt})\n`,
      };

      if (embedImages?.length) {
        const [picked, ...rest] = embedImages;
        payload.secondaryURI = payload.uri;
        payload.uri = picked;
        if (embedText) {
          payload.annotation += `\n** Embed text:\n"${embedText}"\n`;
        }
        if (rest.length) {
          payload.annotation += `\n** Remaining image embeds:\n${rest.join('\n')}\n`;
        }
      }

      if (embedRecords?.length) {
        payload.annotation += `\n** Reposting:\n\n${embedRecords.join('\n---\n')}\n`;
      }

      if (replyCount > 0) {
        const childData = (await agent.getPostThread({
          uri,
          depth: Math.min(replyCount, THREAD_MAX_FETCH_DEPTH)
        })).data;

        const children = processThread(childData);
        if (children.length) {
          payload.annotation += `** OP's remaining thread:\n` + children.map(({ text }) => text).join('\n') + '\n';
        }

        if (process.env.BSKYHLTE_NO_PROCESSING) {
          await writeFile(`${uri.split('/').slice(-1)[0]}.threadData.json`, JSON.stringify(childData, null, 2));
          console.log(payload);
        }
      }

      if (process.env.BSKYHLTE_NO_PROCESSING) {
        continue;
      }

      const response = await hlteFetch(process.env.HLTE_USER_URL, key, payload);

      if (response.status !== 204) {
        console.error(response);
        console.error(`bad hlte fetch: ${response.status} ${response.statusText}`);
        continue;
      }

      await redis.sadd(REDIS_SET_NAME, entry.uri);
      console.debug(response);
      console.log(`Posted ~${JSON.stringify(payload).length} bytes for ${userUrl}`);
    }
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
    console.log(`Session updated & saved. Uptime: ~${Number((Date.now() - START_TS) / 1000 / 60).toFixed(0)} minutes.`);
  }
}


let pollFeedHandle: NodeJS.Timeout;
let resolver = (_) => { };
const redis = new Redis(process.env.REDIS_URL);
function shutdown() {
  console.log('Ending...');
  redis.disconnect();
  clearTimeout(pollFeedHandle);
  resolver((pollFeedHandle = null));
  console.log('Done.');
}

async function main() {
  let handle: string;
  const key = await importKeyFromHexString(process.env.HLTE_USER_KEY);
  const agent = new AtpAgent({
    service: 'https://bsky.social',
    persistSession: agentSessionWasRefreshed.bind(null, redis),
  });

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
    await new Promise((resolve, reject) => {
      resolver = resolve;
      console.debug('Waking up...');
      pollFeed(agent, redis, key, did, handle)
        .then(() => setTimeout(() => resolve(true), POLLING_FREQ_SECONDS * 1000))
        .then(timeoutHandle => (pollFeedHandle = timeoutHandle))
        .then(() => {
          if (process.env.BSKYHLTE_NO_PROCESSING) {
            console.log('BSKYHLTE_NO_PROCESSING is set; ending after one iteration');
            shutdown();
          }
        })
        .catch((error) => {
          console.error(`pollFeed errored: ${error}`);
          reject(error);
        })
    });
  } while (pollFeedHandle);
}

if (require.main === module) {
  main();
}
else {
  module.exports = {
    transformFeed,
    processThread,
  };
}
