export function createOssClient(env) {
  const configured = Boolean(
    env.OSS_REGION && env.OSS_BUCKET && env.OSS_ACCESS_KEY_ID && env.OSS_ACCESS_KEY_SECRET,
  );
  if (!configured) return null;
  return import("ali-oss").then(({ default: OSS }) => new OSS({
    region: env.OSS_REGION,
    bucket: env.OSS_BUCKET,
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    secure: true,
  }));
}

export function objectKey(prefix, key) {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return `${cleanPrefix ? `${cleanPrefix}/` : ""}${key}`;
}

