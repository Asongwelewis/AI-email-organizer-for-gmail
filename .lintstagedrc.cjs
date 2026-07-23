module.exports = {
  '*.{js,cjs,mjs,ts,tsx,json,md,yml,yaml}': ['prettier --write'],
  '*.{ts,tsx}': ['eslint --fix'],
};
