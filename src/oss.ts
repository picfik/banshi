import OSS from "ali-oss";

let client: OSS | null = null;

export function getOssClient(): OSS {
  if (client) return client;
  const { VITE_OSS_AK, VITE_OSS_SK, VITE_OSS_BUCKET, VITE_OSS_REGION } = import.meta.env;
  const missing = [
    ["VITE_OSS_AK", VITE_OSS_AK],
    ["VITE_OSS_SK", VITE_OSS_SK],
    ["VITE_OSS_BUCKET", VITE_OSS_BUCKET],
    ["VITE_OSS_REGION", VITE_OSS_REGION],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`OSS 配置缺失：${missing.join(", ")}`);
  }
  client = new OSS({
    accessKeyId: VITE_OSS_AK,
    accessKeySecret: VITE_OSS_SK,
    bucket: VITE_OSS_BUCKET,
    region: VITE_OSS_REGION,
    secure: true,
  });
  return client;
}

export function getObjectKey(key: string): string {
  const prefix = import.meta.env.VITE_OSS_PREFIX?.replace(/^\/+|\/+$/g, "") || "casework";
  return `${prefix}/${key.replace(/^\/+/, "")}`;
}

export function signOssObject(key: string): string {
  return getOssClient().signatureUrl(key, { expires: 3600 });
}
