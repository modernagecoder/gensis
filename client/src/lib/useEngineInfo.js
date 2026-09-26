// client/src/lib/useEngineInfo.js
// Reads the live model configuration from /api/health so the UI never shows hard-coded model names.
import { useEffect, useState } from 'react';

const DEFAULT_INFO = {
  provider: 'Google Gemini',
  model: { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  arena: {
    a: { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    b: { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  },
};

let cached = null;

export function useEngineInfo() {
  const [info, setInfo] = useState(cached || DEFAULT_INFO);

  useEffect(() => {
    if (cached) return;
    fetch('/api/health')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data?.model) {
          cached = { ...DEFAULT_INFO, ...data };
          setInfo(cached);
        }
      })
      .catch(() => {});
  }, []);

  return info;
}
