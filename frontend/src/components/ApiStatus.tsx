import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHealth, type HealthResponse } from '../api/health';

type Status =
  | { kind: 'loading' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'error'; message: string };

export default function ApiStatus() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const controllerRef = useRef<AbortController | null>(null);

  const check = useCallback(() => {
    // 이전 요청이 아직 진행 중이면 취소하고 새로 요청한다.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus({ kind: 'loading' });
    fetchHealth(controller.signal)
      .then((data) => setStatus({ kind: 'ok', data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // CORS로 막히면 브라우저는 이유를 숨기고 "Failed to fetch"만 알려준다.
        // 자세한 원인은 개발자도구 Console 탭에 나온다.
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  }, []);

  useEffect(() => {
    check();
    return () => controllerRef.current?.abort();
  }, [check]);

  let text: string;
  if (status.kind === 'loading') {
    text = 'API 확인 중…';
  } else if (status.kind === 'ok') {
    const time = new Date(status.data.timestamp).toLocaleTimeString('ko-KR');
    text = `API ${status.data.status} · 서버 시각 ${time}`;
  } else {
    text = `API 연결 실패 · ${status.message}`;
  }

  return (
    <button
      type="button"
      className={`api-status api-status--${status.kind}`}
      onClick={check}
      title="클릭하면 다시 확인합니다"
    >
      {text}
    </button>
  );
}
