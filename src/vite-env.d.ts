/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OSS_AK: string;
  readonly VITE_OSS_SK: string;
  readonly VITE_OSS_BUCKET: string;
  readonly VITE_OSS_REGION: string;
  readonly VITE_OSS_PREFIX?: string;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
