import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 任务状态源。
 *
 * 设计要点：
 * - 主通道是 SSE（`/api/events`），但**不信任它**：上线后先 `GET /api/jobs` 拉全量，
 *   SSE 掉线时刷新兜底。标签页休眠会断流，这是本机浏览器里的常见情况。
 * - `job:done` 只用来触发一次轻提示；任务状态一律以 `job:update` 的完整快照为准。
 */
export function useJobs() {
  const [jobs, setJobs] = useState([]);
  const [health, setHealth] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) throw new Error(`任务列表读取失败 HTTP ${res.status}`);
      const data = await res.json();
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshHealth();

    const es = new EventSource('/api/events');
    esRef.current = es;

    es.addEventListener('hello', () => setConnected(true));

    es.addEventListener('job:update', (ev) => {
      let job;
      try {
        job = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!job || !job.id) return;
      setConnected(true);
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === job.id);
        if (idx < 0) return [job, ...prev];
        const next = prev.slice();
        next[idx] = job;
        return next;
      });
    });

    es.onerror = () => {
      // EventSource 会自动重连；这里只做标记 + 全量兜底刷新，避免漏事件
      setConnected(false);
      refresh();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [refresh, refreshHealth]);

  /** @param {{urls: string[], opts?: {md?: boolean, waitLogin?: boolean}}} body */
  const submit = useCallback(async (body) => {
    setError(null);
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const message = data.error || `提交失败 HTTP ${res.status}`;
      setError(message);
      throw new Error(message);
    }
    return res.json();
  }, []);

  const postAction = useCallback(async (id, action) => {
    const res = await fetch(`/api/jobs/${id}${action}`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `操作失败 HTTP ${res.status}`);
    }
    return res.json();
  }, []);

  const cancel = useCallback((id) => postAction(id, '/cancel'), [postAction]);
  const resumeLogin = useCallback((id) => postAction(id, '/resume-login'), [postAction]);

  return { jobs, health, connected, error, submit, cancel, resumeLogin, refresh, refreshHealth };
}
