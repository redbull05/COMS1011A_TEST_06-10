'use strict';

/**
 * RAT frontend - Sprint 0.
 * Verifies the backend is reachable and reflects it in the header status pill.
 */

async function checkHealth() {
  const el = document.getElementById('health-status');
  if (!el) return;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    el.className = 'status ok';
    el.innerHTML = '<span class="dot"></span>backend ok · v' + data.version;
  } catch (err) {
    el.className = 'status err';
    el.innerHTML = '<span class="dot"></span>backend unreachable';
    console.error('[rat] health check failed:', err);
  }
}

checkHealth();
