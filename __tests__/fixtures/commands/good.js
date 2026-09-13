// A well-formed command used by the loader tests.
module.exports = {
  data: { name: 'good', toJSON: () => ({ name: 'good' }) },
  execute: async () => {}
};
