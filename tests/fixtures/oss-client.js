export const getOssClient = () => globalThis.__testOssClient;
export const getObjectKey = (key) => `test/${key}`;
export const signOssObject = (key) => `https://example.test/${key}`;
