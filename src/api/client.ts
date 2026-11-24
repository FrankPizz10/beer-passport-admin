import { auth } from "../Firebase/firebase";

export class ApiError extends Error {
  status: number;
  // The parsed error body, when the API sent one. The manifest build
  // endpoint uses it to carry the structured 422 blockers list so the
  // UI can render blocking candidates readably.
  details?: any;

  constructor(status: number, message: string, details?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export const API_BASE_URL =
  process.env.REACT_APP_ADMIN_API_URL || "http://localhost:4100";

export type QueryParams = Record<
  string,
  string | number | boolean | undefined | null
>;

export async function apiGet<T>(path: string, params?: QueryParams): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const url = new URL(`${API_BASE_URL}/admin-api/v1${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch (e) {
    body = null;
  }
  if (!response.ok) {
    const message =
      (body && body.error && body.error.message) ||
      (body && body.message) ||
      response.statusText ||
      `Request failed with status ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

// Authenticated binary GET that returns an object URL for the bytes.
// Used by the discovery image review panel: the preview endpoint
// sits behind the same Bearer auth as every admin route, so an <img>
// cannot point at it directly; the panel fetches the stored bytes
// through here and renders the blob URL. The bytes always come from
// the API's content-addressed store, never from the image's origin.
export async function apiGetBlobUrl(path: string): Promise<string> {
  const token = await auth.currentUser?.getIdToken();
  const url = new URL(`${API_BASE_URL}/admin-api/v1${path}`);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    let message = response.statusText || `Request failed with status ${response.status}`;
    try {
      const body = await response.json();
      if (body && body.error && body.error.message) message = body.error.message;
    } catch (e) {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(response.status, message);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

// POST counterpart of apiGet, used only by the image approval actions
// (the API's only mutation endpoints). Same auth header, same error
// shape, so callers handle ApiError uniformly.
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const url = new URL(`${API_BASE_URL}/admin-api/v1${path}`);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch (e) {
    parsed = null;
  }
  if (!response.ok) {
    const message =
      (parsed && parsed.error && parsed.error.message) ||
      (parsed && parsed.message) ||
      response.statusText ||
      `Request failed with status ${response.status}`;
    throw new ApiError(response.status, message, parsed ?? undefined);
  }
  return parsed as T;
}
