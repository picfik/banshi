export const getOssClient = () => globalThis.__testOssClient;
export const getObjectKey = (key) => `test/${key}`;
export const signOssObject = (key, options = {}) => {
  globalThis.__lastSignedOssObject = { key, options };
  return `https://example.test/${key}`;
};
