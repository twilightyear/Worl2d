import { API_BASE_URL } from './config';

// 백엔드 record HealthResponse(String status, Instant timestamp)와 같은 모양.
// Instant는 JSON에서 ISO-8601 문자열(예: "2026-10-20T15:33:21.621357Z")로 온다.
export type HealthResponse = {
  status: string;
  timestamp: string;
};

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/health`, { signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as HealthResponse;
}
