// Proves the loader recurses into subdirectories.
module.exports = {
  data: { name: 'deep', toJSON: () => ({ name: 'deep' }) },
  execute: async () => {}
};
