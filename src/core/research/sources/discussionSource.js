// Discussion search: forums, Q&A, issue threads, community posts.
//
// Discussions answer a question no documentation can — "does this actually work
// in practice, and what breaks?" — and they are the least reliable thing in the
// corpus. This adapter keeps the signals that separate a well-received answer
// from a stray comment (score, accepted flag, reply count) and marks every row
// as non-primary so a claim resting only on discussions can never reach
// `strongly_supported`.

const { SOURCE_TYPES } = require('../schemas/source');
const { createAdapter, baseMap, pick } = require('./adapter');

function createDiscussionSource() {
  return createAdapter({
    id: 'discussion',
    type: SOURCE_TYPES.DISCUSSION,
    label: 'Discussion search',
    description: 'Forums, Q&A sites and community threads. Opinion-weighted, never primary.',
    providerTypes: [SOURCE_TYPES.DISCUSSION, SOURCE_TYPES.WEB],
    defaultAuthority: 0.3,
    map: (row) => {
      const score = pick(row, ['score', 'points', 'upvotes', 'votes'], null);
      const replies = pick(row, ['replies', 'commentCount', 'answerCount', 'num_comments'], null);
      return {
        ...baseMap(row, { type: SOURCE_TYPES.DISCUSSION }),
        primary: false,
        metadata: {
          communityScore: typeof score === 'number' ? score : null,
          replyCount: typeof replies === 'number' ? replies : null,
          accepted: row && (row.isAccepted === true || row.accepted === true),
          // A thread is a set of opinions; treating one post as the position of
          // "the community" is exactly the mistake §17 is about.
          opinion: true,
        },
      };
    },
  });
}

module.exports = { createDiscussionSource };
