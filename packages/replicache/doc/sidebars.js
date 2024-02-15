const {toEditorSettings} = require('typescript');

module.exports = {
  docs: [
    // TODO clean out the unused docs
    {
      'Hello, Replicache': [
        'tutorial/introduction',
        'tutorial/constructing-replicache',
        'tutorial/adding-mutators',
        'tutorial/subscriptions',
        'tutorial/sync',
        'tutorial/next-steps',
      ],
    },
    {
      Examples: ['examples/todo', 'examples/repliear'],
    },
    {
      'Build Your Own Backend': [
        'byob/intro',
        'byob/install-replicache',
        'byob/design-client-view',
        'byob/render-ui',
        'byob/local-mutations',
        'byob/database-setup',
        'byob/database-schema',
        'byob/remote-mutations',
        'byob/dynamic-pull',
        'byob/poke',
        'byob/conclusion',
      ],
    },
    {
      'Backend Strategies': [
        'strategies/overview',
        'strategies/reset',
        'strategies/global-version',
        'strategies/per-space-version',
        'strategies/row-version',
      ],
    },
    {
      'Understand Replicache': [
        'concepts/how-it-works',
        'concepts/performance',
        'concepts/offline',
        'concepts/consistency',
        'concepts/licensing',
      ],
    },
    {
      Reference: [
        {
          'JavaScript Reference': [
            {
              type: 'autogenerated',
              dirName: 'api', // 'api' is the 'out' directory
            },
          ],
        },
        'reference/server-push',
        'reference/server-pull',
      ],
    },
    {
      'How To': [
        'howto/blobs',
        'howto/launch',
        'howto/share-mutators',
        'howto/source-access',
        'howto/text',
        'howto/unit-test',
      ],
    },
    {
      type: 'link',
      label: 'Releases',
      href: 'https://replicache.notion.site/Replicache-Releases-f86ffef7f72f46ca9b597d5081e05b88',
    },
  ],
};
