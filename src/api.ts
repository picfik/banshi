export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 204) return undefined as T;
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      result?.error?.message ?? `请求失败（${response.status}）`,
      response.status,
      result?.error?.code ?? "REQUEST_FAILED",
    );
  }
  return result as T;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

