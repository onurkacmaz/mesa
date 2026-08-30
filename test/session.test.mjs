import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_VERSION, counterSeedsFrom, normalizeSession } from '../src/session.mjs';

// A pane is a box of sessions now, so the helper takes the tab fields it used
// to take directly and wraps them — every existing test still reads as "a pane
// that is one terminal", which is what they were written about.
const pane = ({ id = 'term-1', kind = 'terminal', tabs, ...over } = {}) => {
  const { title, titleLocked, cwd, url, command, ...box } = over;
  return {
    id,
    kind,
    x: 10,
    y: 20,
    width: 1360,
    height: 780,
    z: 3,
    tabs: tabs ?? [{ id, title: title ?? 'Terminal 1', titleLocked, cwd, url, command }],
    activeTabId: id,
    ...box
  };
};

const firstTab = (restored, index = 0) => restored.workflows[0].panes[index].tabs[0];

const session = (over = {}) => ({
  version: SESSION_VERSION,
  activeWorkflowId: 'wf-1',
  counters: {},
  workflows: [
    {
      id: 'wf-1',
      name: 'api',
      view: { zoom: 0.8, pan: { x: -420, y: -180 } },
      panes: [pane()]
    }
  ],
  ...over
});

test('restores a well-formed session unchanged', () => {
  const restored = normalizeSession(session());
  assert.equal(restored.workflows.length, 1);
  assert.equal(restored.activeWorkflowId, 'wf-1');
  assert.deepEqual(restored.workflows[0].view, { zoom: 0.8, pan: { x: -420, y: -180 } });
  assert.equal(restored.workflows[0].panes[0].id, 'term-1');
  assert.equal(firstTab(restored).id, 'term-1');
});

test('survives a round trip through JSON', () => {
  const before = normalizeSession(session());
  const after = normalizeSession(JSON.parse(JSON.stringify(before)));
  assert.deepEqual(after, before);
});

test('refuses anything that is not a session', () => {
  for (const raw of [null, undefined, 'nope', 42, [], {}]) {
    assert.equal(normalizeSession(raw), null);
  }
});

test('refuses a version it does not know', () => {
  assert.equal(normalizeSession(session({ version: 99 })), null);
  assert.equal(normalizeSession(session({ version: undefined })), null);
});

test('an empty workflow list reads as no session at all', () => {
  assert.equal(normalizeSession(session({ workflows: [] })), null);
});

test('drops a pane with no usable geometry and keeps the rest', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        {
          id: 'wf-1',
          name: 'api',
          panes: [pane({ id: 'term-1', width: 0 }), pane({ id: 'term-2' })]
        }
      ]
    })
  );
  assert.deepEqual(
    restored.workflows[0].panes.map((p) => p.id),
    ['term-2']
  );
});

// Ropes between panes were removed in v1.4. A file written by an earlier
// build still carries them, and the rule that a bad file costs no more than
// the layout it held applies just as much to a file that is merely old: the
// key is passed over, and the workflow it was sitting in opens normally.
test('a session written before ropes were removed still opens, without them', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        {
          id: 'wf-1',
          name: 'api',
          panes: [pane({ id: 'term-1' }), pane({ id: 'term-2' })],
          connections: [{ id: 'conn-1', from: 'term-1', to: 'term-2' }]
        }
      ]
    })
  );
  assert.deepEqual(
    restored.workflows[0].panes.map((p) => p.id),
    ['term-1', 'term-2']
  );
  assert.equal('connections' in restored.workflows[0], false);
});

test('two panes never share an id, across workflows as well as within one', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        { id: 'wf-1', name: 'a', panes: [pane({ id: 'term-1' }), pane({ id: 'term-1' })] },
        { id: 'wf-2', name: 'b', panes: [pane({ id: 'term-1' }), pane({ id: 'term-2' })] }
      ]
    })
  );
  assert.deepEqual(restored.workflows[0].panes.map((p) => p.id), ['term-1']);
  assert.deepEqual(restored.workflows[1].panes.map((p) => p.id), ['term-2']);
});

test('falls back to the first workflow when the active one is gone', () => {
  const restored = normalizeSession(session({ activeWorkflowId: 'wf-404' }));
  assert.equal(restored.activeWorkflowId, 'wf-1');
});

test('keeps a browser url and a terminal cwd, and never crosses them', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        {
          id: 'wf-1',
          name: 'a',
          panes: [
            pane({ id: 'term-1', cwd: '/tmp', url: 'https://example.com' }),
            pane({ id: 'term-2', kind: 'browser', title: 'Browser 2', cwd: '/tmp', url: 'https://example.com' })
          ]
        }
      ]
    })
  );
  const [terminal, browser] = restored.workflows[0].panes.map((p) => p.tabs[0]);
  assert.equal(terminal.cwd, '/tmp');
  assert.equal(terminal.url, undefined);
  assert.equal(browser.url, 'https://example.com');
  assert.equal(browser.cwd, undefined);
});

test('a startup command survives, stripped of anything that could run it', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        {
          id: 'wf-1',
          name: 'a',
          panes: [
            pane({ id: 'term-1', command: 'npm run dev' }),
            pane({ id: 'term-2', command: 'rm -rf /\r' }),
            pane({ id: 'term-3', command: 'echo hi\nmake deploy' }),
            pane({ id: 'term-5', command: '\x1b[200~evil' }),
            pane({ id: 'term-8', command: '   \r\n  ' })
          ]
        }
      ]
    })
  );
  const commands = restored.workflows[0].panes.map((p) => p.tabs[0].command);
  assert.deepEqual(commands, [
    'npm run dev',
    'rm -rf /',
    'echo himake deploy',
    '[200~evil',
    // Nothing but control characters and space left nothing at all, and an
    // empty command is no command.
    undefined
  ]);
  for (const command of commands) {
    if (command) assert.ok(!/[\x00-\x1f\x7f]/.test(command));
  }
});

test('a browser pane carries no startup command', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        {
          id: 'wf-1',
          name: 'a',
          panes: [pane({ id: 'term-1', kind: 'browser', command: 'npm run dev' })]
        }
      ]
    })
  );
  assert.equal(firstTab(restored).command, undefined);
});

test('repairs a broken view rather than dropping the workflow', () => {
  const restored = normalizeSession(
    session({
      workflows: [{ id: 'wf-1', name: 'a', view: { zoom: 0, pan: 'nope' }, panes: [pane()] }]
    })
  );
  assert.deepEqual(restored.workflows[0].view, { zoom: 1, pan: { x: 0, y: 0 } });
});

test('counters resume past every restored id', () => {
  const seeds = counterSeedsFrom(
    normalizeSession(
      session({
        workflows: [
          {
            id: 'wf-3',
            name: 'a',
            panes: [pane({ id: 'term-7', title: 'Terminal 7', z: 12 })]
          }
        ],
        activeWorkflowId: 'wf-3'
      })
    )
  );
  assert.equal(seeds.pane, 7);
  assert.equal(seeds.workflow, 3);
  assert.equal(seeds.session, 7);
  assert.equal(seeds.z, 12);
});

test('a stale counters block can only raise a seed, never lower it', () => {
  const raw = normalizeSession(session({ counters: { pane: 0, workflow: 0, session: 99 } }));
  const seeds = counterSeedsFrom(raw);
  assert.equal(seeds.pane, 1); // from term-1, not the 0 on file
  assert.equal(seeds.workflow, 1); // from wf-1
  assert.equal(seeds.session, 99); // nothing restored claims a higher one
});

// A rope id from an old file used to be able to claim a number the pane
// counter had to clear. With ropes gone the only ids in play are panes' and
// tabs', and a stale conn-N on disk names nothing that is still restored — so
// the next pane id follows the highest pane, and the old rope number does not
// push it along.
test('a rope id left on disk no longer pushes the pane counter along', () => {
  const seeds = counterSeedsFrom(
    normalizeSession(
      session({
        workflows: [
          {
            id: 'wf-1',
            name: 'a',
            panes: [pane({ id: 'term-7' }), pane({ id: 'term-2' })],
            connections: [{ id: 'conn-9', from: 'term-7', to: 'term-2' }]
          }
        ]
      })
    )
  );
  assert.equal(seeds.pane, 7);
  assert.equal(seeds.conn, undefined);
});

test('a renamed pane contributes no session number', () => {
  const seeds = counterSeedsFrom(
    normalizeSession(
      session({
        workflows: [{ id: 'wf-1', name: 'a', panes: [pane({ title: 'deploy' })] }]
      })
    )
  );
  assert.equal(seeds.session, 0);
});

// ── Tabs ───────────────────────────────────────────────────────────────────

test('a v1 session becomes a v2 one, each pane holding the session it was', () => {
  const restored = normalizeSession({
    version: 1,
    activeWorkflowId: 'wf-1',
    counters: { pane: 3 },
    workflows: [
      {
        id: 'wf-1',
        name: 'api',
        view: { zoom: 0.5, pan: { x: 10, y: 20 } },
        panes: [
          {
            id: 'term-3',
            kind: 'terminal',
            x: 1,
            y: 2,
            width: 100,
            height: 200,
            z: 4,
            title: 'build',
            titleLocked: true,
            cwd: '/tmp',
            command: 'npm run dev'
          },
          {
            id: 'term-5',
            kind: 'browser',
            x: 3,
            y: 4,
            width: 100,
            height: 200,
            z: 5,
            title: 'Browser 5',
            url: 'https://example.com'
          }
        ],
        connections: [{ id: 'conn-6', from: 'term-3', to: 'term-5' }]
      }
    ]
  });

  const [terminal, browser] = restored.workflows[0].panes;
  // The tab keeps the pane's id: in v1 that id WAS the session's id, so this
  // is the same session keeping its name, not a coincidence.
  assert.deepEqual(terminal.tabs, [
    { id: 'term-3', title: 'build', titleLocked: true, cwd: '/tmp', command: 'npm run dev' }
  ]);
  assert.equal(terminal.activeTabId, 'term-3');
  assert.equal(browser.tabs[0].url, 'https://example.com');
  assert.deepEqual(restored.workflows[0].view, { zoom: 0.5, pan: { x: 10, y: 20 } });
});

test('a pane holds many tabs and remembers which one was in front', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        {
          id: 'wf-1',
          name: 'a',
          panes: [
            pane({
              id: 'term-1',
              tabs: [
                { id: 'term-1', title: 'one', cwd: '/one' },
                { id: 'term-4', title: 'two', cwd: '/two', command: 'npm test' },
                { id: 'term-6', title: 'three' }
              ],
              activeTabId: 'term-4'
            })
          ]
        }
      ]
    })
  );
  const restoredPane = restored.workflows[0].panes[0];
  assert.deepEqual(restoredPane.tabs.map((t) => t.id), ['term-1', 'term-4', 'term-6']);
  assert.equal(restoredPane.activeTabId, 'term-4');
  assert.equal(restoredPane.tabs[1].command, 'npm test');
});

test('an active tab that is gone falls back to the first', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        {
          id: 'wf-1',
          name: 'a',
          panes: [pane({ id: 'term-1', activeTabId: 'term-404' })]
        }
      ]
    })
  );
  assert.equal(restored.workflows[0].panes[0].activeTabId, 'term-1');
});

test('a pane with no tabs left is an empty box, and is dropped', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        { id: 'wf-1', name: 'a', panes: [pane({ id: 'term-1', tabs: [] }), pane({ id: 'term-2' })] }
      ]
    })
  );
  // The workflow itself survives — an empty workflow is a real thing someone
  // can be looking at — but the box with nothing in it does not.
  assert.deepEqual(restored.workflows[0].panes.map((p) => p.id), ['term-2']);
});

test('no two tabs share an id, in one pane or across workflows', () => {
  const restored = normalizeSession(
    session({
      workflows: [
        {
          id: 'wf-1',
          name: 'a',
          panes: [
            pane({
              id: 'term-1',
              tabs: [
                { id: 'term-1', title: 'one' },
                { id: 'term-1', title: 'duplicate' }
              ]
            })
          ]
        },
        {
          id: 'wf-2',
          name: 'b',
          panes: [
            pane({
              id: 'term-2',
              tabs: [
                { id: 'term-1', title: 'stolen' },
                { id: 'term-9', title: 'own' }
              ],
              activeTabId: 'term-9'
            })
          ]
        }
      ]
    })
  );
  assert.deepEqual(restored.workflows[0].panes[0].tabs.map((t) => t.id), ['term-1']);
  assert.deepEqual(restored.workflows[1].panes[0].tabs.map((t) => t.id), ['term-9']);
});

test('counters clear every tab id, not just the pane ids', () => {
  const seeds = counterSeedsFrom(
    normalizeSession(
      session({
        workflows: [
          {
            id: 'wf-1',
            name: 'a',
            panes: [
              pane({
                id: 'term-2',
                tabs: [
                  { id: 'term-2', title: 'Terminal 2' },
                  { id: 'term-11', title: 'Terminal 11' }
                ]
              })
            ]
          }
        ]
      })
    )
  );
  // The next id off the shared counter must clear term-11, not just term-2.
  assert.equal(seeds.pane, 11);
  assert.equal(seeds.session, 11);
});
