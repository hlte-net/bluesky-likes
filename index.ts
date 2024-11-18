import { AtpAgent } from '@atproto/api';
import { password } from '@inquirer/prompts';
import { inspect } from 'util';

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
      params.authFactorToken = await password({ message: 'Enter the auth code sent to you via email:' });
      return agent.login(params);
    }

    throw e;
  }

}
async function main() {
  const agent = new AtpAgent({
    service: 'https://bsky.social'
  });

  const { data: { handle, email }} = await login(agent);
  console.log(`Logged in succesfully as @${handle} <${email}>`);

  const { data: { feed, cursor } } = await agent.getActorLikes({ actor: "did:plc:4wmdvmdqinee3knh23qan7d7" });
  console.log(inspect(feed, false, null, true))
  console.log(cursor);
}

main();
