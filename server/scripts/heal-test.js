// server/scripts/heal-test.js
// Proves the self-healing loop with a real LLM: a game with planted bugs goes through
// detect (Playwright) -> diagnose & patch (Gemini) -> re-verify, until the suite passes.
//   node scripts/heal-test.js

import '../loadEnv.js';
import { runTests } from '../services/playwright-runner.js';
import { packageFailure, requestDiagnosisAndPatch } from '../services/pipeline.js';

// Planted bugs:
//  1. No boundary clamp: holding ArrowLeft drives the ship to negative x.
//  2. Firing (Space) calls an undefined function -> ReferenceError during play.
//  3. Firing also crashes the loop because of bug 2, so later input is dead.
const BROKEN_GAME = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Broken Blaster</title>
<style>body{margin:0;background:#0b0c12}canvas{display:block;margin:0 auto;background:#12131c}</style></head>
<body>
<canvas id="game" width="800" height="600"></canvas>
<script>
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const keys = {};
window.addEventListener('keydown', e => { keys[e.key] = true; keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { keys[e.key] = false; keys[e.key.toLowerCase()] = false; });
const player = { x: 380, y: 540, width: 40, height: 24, speed: 7, health: 3 };
let bullets = [], rocks = [], score = 0, status = 'playing', t = 0;
function update() {
  t++;
  if (keys.ArrowLeft || keys.a) player.x -= player.speed;
  if (keys.ArrowRight || keys.d) player.x += player.speed;
  // BUG 1: no clamp
  if (keys[' ']) spawnBulletFromShip(player);   // BUG 2: function never defined
  if (t % 40 === 0) rocks.push({ x: Math.random() * 760, y: -20, r: 16, vy: 2 + Math.random() * 2 });
  rocks.forEach(r => r.y += r.vy);
  bullets.forEach(b => b.y -= 9);
  rocks = rocks.filter(r => r.y < 640);
  bullets = bullets.filter(b => b.y > -10);
}
function draw() {
  ctx.fillStyle = '#12131c'; ctx.fillRect(0, 0, 800, 600);
  ctx.fillStyle = '#d8125b'; ctx.fillRect(player.x, player.y, player.width, player.height);
  ctx.fillStyle = '#aaa'; rocks.forEach(r => { ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = '#fff'; ctx.font = '16px monospace'; ctx.fillText('Score ' + score + '  Lives ' + player.health, 12, 24);
}
function loop() {
  update(); draw();
  window.__gameState = { player: { x: player.x, y: player.y, width: player.width, height: player.height, health: player.health, speed: player.speed }, score, status, entities: rocks.concat(bullets) };
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script>
</body>
</html>`;

const log = (type, msg) => {
  if (['error', 'warning', 'success', 'stage'].includes(type)) console.log(`  [${type}] ${msg}`);
};

let code = BROKEN_GAME;
const jobId = `healtest_${Date.now()}`;
const MAX = 3;

for (let attempt = 1; attempt <= MAX + 1; attempt++) {
  console.log(`\n▶ Build #${attempt}: running sensory suite`);
  const result = await runTests(jobId, code, attempt, log);
  const failed = result.assertions.filter(a => !a.passed);
  console.log(`  → ${result.passed ? 'PASSED' : 'FAILED'}  (${result.assertions.length - failed.length}/${result.assertions.length}; failing: ${failed.map(a => a.name).join(', ') || 'none'})`);

  if (attempt === 1 && result.passed) {
    console.error('✘ The planted bugs were NOT detected — test harness is not doing its job.');
    process.exit(1);
  }
  if (result.passed) {
    console.log(`\n\x1b[32m✔ SELF-HEALED: planted bugs detected and fixed by Gemini in ${attempt - 1} patch cycle(s)\x1b[0m`);
    console.log(`  fixed build: games/${jobId}_v${attempt}.html`);
    process.exit(0);
  }
  if (attempt > MAX) break;

  console.log(`▶ Asking Gemini to diagnose & patch...`);
  const patch = await requestDiagnosisAndPatch(jobId, code, packageFailure(failed, code), log);
  if (!patch.patchedCode) {
    console.log('  patch rejected/failed:', patch.rationale || patch.diagnosis);
    continue;
  }
  console.log(`  diagnosis: ${patch.diagnosis.replace(/\s+/g, ' ').slice(0, 300)}`);
  code = patch.patchedCode;
}

console.error('\n\x1b[31m✘ Did not converge within the heal budget\x1b[0m');
process.exit(1);
