import { auth } from "../Firebase/firebase";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
    throw new ApiError(response.status, message);
  }
  return parsed as T;
}
