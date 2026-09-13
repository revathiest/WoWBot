// Missing `execute`, so the loader should skip it.
module.exports = { data: { name: 'noExecute', toJSON: () => ({ name: 'noExecute' }) } };
