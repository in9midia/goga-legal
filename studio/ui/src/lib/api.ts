// Cliente HTTP do Studio. Sessao por cookie (httpOnly), entao nao ha token para
// guardar no navegador: `credentials: "include"` e tudo.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    headers: body && !isForm ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("studio:unauthorized"));
    throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
  upload: <T>(p: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<T>("POST", p, fd);
  },
};

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const fileUrl = (id: string, inline = false) => `/api/v1/files/${id}${inline ? "?inline=1" : ""}`;
