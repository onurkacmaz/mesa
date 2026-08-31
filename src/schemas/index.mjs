// The CLIs Mesa knows the shape of.
//
// Hand-written and deliberately few. Everything outside this set still
// completes from history, from the files in the working directory and from
// PATH, so the cost of not being here is small — while the cost of adopting a
// large third-party spec repository would be running its spec code.
//
// Adding one is a JSON file and a line here. A `generator` named in one of
// them has to exist in the main process table (electron/completionSources.js)
// or the node silently offers nothing; test/schema.test.mjs checks that.

import brew from './brew.json' with { type: 'json' };
import cd from './cd.json' with { type: 'json' };
import docker from './docker.json' with { type: 'json' };
import git from './git.json' with { type: 'json' };
import kubectl from './kubectl.json' with { type: 'json' };
import npm from './npm.json' with { type: 'json' };
import ssh from './ssh.json' with { type: 'json' };

export const SCHEMAS = { brew, cd, docker, git, kubectl, npm, ssh };
