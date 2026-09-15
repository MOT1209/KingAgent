// The research schema barrel. Everything the engine passes around has its shape
// defined here and nowhere else.

module.exports = {
  ...require('./source'),
  ...require('./researchQuery'),
  ...require('./researchResult'),
  ...require('./evidence'),
  ...require('./claim'),
  ...require('./citation'),
  ...require('./researchTask'),
};
