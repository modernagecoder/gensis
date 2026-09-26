// client/src/components/EngineMetricsBar.jsx
// Engine health statistics computed from the persisted build history, plus the live model configuration

import React, { useState } from 'react';
import { useEngineInfo } from '../lib/useEngineInfo.js';
import './EngineMetricsBar.css';

export default function EngineMetricsBar({ totalGames = 0, totalVerified = 0, totalHeals = 0 }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const engine = useEngineInfo();

  const passRate = totalGames > 0 ? `${((totalVerified / totalGames) * 100).toFixed(1)}% PASS` : '— no builds yet';
  const avgHeals = totalGames > 0 ? (totalHeals / totalGames).toFixed(1) : '—';

  return (
    <div className="engine-metrics-bar">
      <div className="metrics-summary" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="metrics-badge">
          <span className="pulse-dot"></span>
          <span>SYSTEM TELEMETRY</span>
        </div>

        <div className="metrics-items">
          <div className="metric-cell" title="Share of your builds that passed automated verification">
            <span className="metric-k">PROVE PLAYABILITY:</span>
            <span className="metric-v highlight-green">{passRate}</span>
          </div>

          <div className="metric-divider">|</div>

          <div className="metric-cell" title="Average self-healing iterations per build">
            <span className="metric-k">AVG HEAL CYCLES:</span>
            <span className="metric-v highlight-fuchsia">{avgHeals}</span>
          </div>

          <div className="metric-divider">|</div>

          <div className="metric-cell" title="Model used for spec, code synthesis and self-healing">
            <span className="metric-k">ENGINE:</span>
            <span className="metric-v font-mono">{engine.model.label}</span>
          </div>

          <div className="metric-divider">|</div>

          <div className="metric-cell" title="Active sensory assertions per candidate build">
            <span className="metric-k">SENSORY SUITE:</span>
            <span className="metric-v">11 Hard Error & Physics Traps</span>
          </div>
        </div>

        <button className="metrics-expand-btn font-mono" type="button">
          {isExpanded ? '▲ Hide Benchmarks' : '▼ Engine Specs'}
        </button>
      </div>

      {isExpanded && (
        <div className="metrics-expanded-panel fade-in">
          <div className="panel-col">
            <h4>Sensory Verification Radar</h4>
            <ul className="spec-list font-mono">
              <li><span className="bullet">✓</span> Hard Crash & Syntax Traps (TypeError, ReferenceError), re-checked after playtest</li>
              <li><span className="bullet">✓</span> Canvas Liveness (non-blank pixels, frame hash changes)</li>
              <li><span className="bullet">✓</span> Game Loop Health (requestAnimationFrame rate)</li>
              <li><span className="bullet">✓</span> Input Responsiveness (bot-driven Arrow/WASD displacement)</li>
              <li><span className="bullet">✓</span> Boundary Clamping & Entity Leak Detection</li>
            </ul>
          </div>

          <div className="panel-col">
            <h4>Autonomous Engine Architecture</h4>
            <div className="nim-spec-table font-mono">
              <div className="nim-row">
                <span className="nim-name">Primary LLM</span>
                <span className="nim-val">{engine.model.id} · {engine.provider}</span>
              </div>
              <div className="nim-row">
                <span className="nim-name">Arena</span>
                <span className="nim-val">{engine.arena.a.label} vs {engine.arena.b.label}</span>
              </div>
              <div className="nim-row">
                <span className="nim-name">Headless Sandbox</span>
                <span className="nim-val">Playwright Chromium · network isolated</span>
              </div>
              <div className="nim-row">
                <span className="nim-name">Database WAL</span>
                <span className="nim-val">SQLite3 Persistent Concurrency</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
