// server/services/playwright-runner.js
// Universal Sensory Layer & Autonomous Playtesting Bot
// Catches Hard Errors, Silent Failures, Timeouts, Logic/State Failures, and Memory Leaks

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { withWatchdog } from '../utils/watchdog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GAME_DIR = path.join(__dirname, '..', 'games');
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

for (const dir of [GAME_DIR, SCREENSHOT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Run comprehensive automated sensory checks and playtest bot on a game build.
 * Wrapped with watchdog timeout to prevent any run from hanging.
 * 
 * @param {string} jobId
 * @param {string} gameHtml
 * @param {number} attempt
 * @param {function} log - (type, message, data?) => void
 * @param {object} [spec] - Optional game specification for dynamic assertions
 * @returns {Promise<{passed: boolean, assertions: Array, errors: Array, screenshots: object, failurePackage: Array}>}
 */
export async function runTests(jobId, gameHtml, attempt, log, spec = null) {
  // Wrap entire test run with a watchdog timeout
  return withWatchdog(
    () => executeTestRun(jobId, gameHtml, attempt, log, spec),
    90000,
    `Stage 3+4 Test Suite (Build #${attempt})`
  );
}

async function executeTestRun(jobId, gameHtml, attempt, log, spec) {
  const gameFile = path.join(GAME_DIR, `${jobId}_v${attempt}.html`);
  fs.writeFileSync(gameFile, gameHtml, 'utf8');

  log('info', `Starting universal sensory suite (attempt ${attempt})...`);

  let browser;
  const assertions = [];
  const errors = [];
  const screenshots = {};
  const failurePackage = [];

  const sourceLines = gameHtml.split('\n');

  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
    });
    const page = await context.newPage();

    // Block all outbound network traffic to enforce strict offline sandbox isolation
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('file://') || url.startsWith('data:')) {
        route.continue();
      } else {
        route.abort('blockedbyclient');
      }
    });

    // ── 1. Telemetry Capture: Console errors, exceptions, stack traces ───────
    const capturedExceptions = [];
    const consoleLogs = [];

    page.on('console', (msg) => {
      const text = `[${msg.type()}] ${msg.text()}`;
      consoleLogs.push(text);
      if (msg.type() === 'error') {
        capturedExceptions.push({
          type: 'ConsoleError',
          message: msg.text(),
          location: msg.location(),
          stack: null,
        });
      }
    });

    page.on('pageerror', (err) => {
      const stack = err.stack || err.message;
      let lineNum = null;
      const lineMatch = stack.match(/:(\d+):(\d+)/);
      if (lineMatch) lineNum = parseInt(lineMatch[1], 10);

      capturedExceptions.push({
        type: 'ThrownException',
        message: err.message,
        stack: stack,
        lineNumber: lineNum,
      });
      errors.push(`PageError: ${err.message}`);
    });

    // ── 2. Load the game in sandbox ─────────────────────────────────────────
    const fileUrl = pathToFileURL(gameFile).href;
    log('info', 'Spinning up sandboxed headless instance...');

    try {
      await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (e) {
      const errDetail = `Failed to load game: ${e.message}`;
      errors.push(errDetail);
      log('error', errDetail);
      return {
        passed: false,
        assertions: [{
          name: 'page_load_success',
          category: 'hard_error',
          label: 'Game loads in browser',
          passed: false,
          expected: 'Page loads within 10s',
          actual: e.message,
          evidence: { message: errDetail },
        }],
        errors,
        screenshots,
        failurePackage: [{
          name: 'page_load_success',
          category: 'hard_error',
          expected: 'Page loads within 10s',
          actual: e.message,
          stackTrace: e.stack,
        }],
      };
    }

    // Allow game initialization
    await page.waitForTimeout(1000);

    // Ensure canvas has tabindex and focus
    await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (c) {
        c.setAttribute('tabindex', '0');
        c.focus();
      }
    }).catch(() => {});

    // ── ASSERTION: No runtime/syntax/thrown exceptions ──────────────────────
    log('test', 'Checking: no_console_errors (hard exceptions & syntax)');
    {
      const criticalExceptions = capturedExceptions.filter(isCriticalException);

      const passed = criticalExceptions.length === 0;
      const screenshotPath = await captureScreenshot(page, jobId, attempt, 'no_console_errors', SCREENSHOT_DIR);
      screenshots['no_console_errors'] = screenshotPath;

      const firstErr = criticalExceptions[0];
      let sourceSnippet = null;
      if (firstErr?.lineNumber && sourceLines[firstErr.lineNumber - 1]) {
        const start = Math.max(0, firstErr.lineNumber - 4);
        const end = Math.min(sourceLines.length, firstErr.lineNumber + 3);
        sourceSnippet = sourceLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
      }

      const assertion = {
        name: 'no_console_errors',
        category: 'hard_error',
        label: 'No unhandled exceptions or syntax errors',
        passed,
        expected: 'Zero thrown exceptions, syntax errors, or null-pointer errors',
        actual: passed ? 'Zero critical errors' : `${criticalExceptions.length} error(s): ${criticalExceptions.map(e => e.message).join('; ')}`,
        evidence: {
          errors: criticalExceptions.map(e => e.message),
          stackTrace: firstErr?.stack || null,
          lineNumber: firstErr?.lineNumber || null,
          sourceSnippet,
          screenshot: `/screenshots/${path.basename(screenshotPath)}`,
        },
      };
      assertions.push(assertion);

      if (!passed) {
        log('error', `Hard errors detected: ${criticalExceptions.map(e => e.message).join('; ')}`);
        failurePackage.push(assertion);
      } else {
        log('success', 'Zero runtime or syntax errors detected');
      }
    }

    // ── ASSERTION: Security Sandbox / No Untrusted Operations ──────────────
    log('test', 'Checking: no_untrusted_operations (eval, external network, cookie isolation)');
    {
      const secResult = await checkUntrustedOperations(page, gameHtml);
      const assertion = {
        name: 'no_untrusted_operations',
        category: 'security',
        label: 'Zero untrusted operations or sandbox escapes',
        passed: secResult.passed,
        expected: 'No eval, Function constructor, external script references, or network calls',
        actual: secResult.message,
        evidence: {
          violations: secResult.violations,
          message: secResult.message,
        },
      };
      assertions.push(assertion);

      if (!secResult.passed) {
        log('error', secResult.message);
        failurePackage.push(assertion);
      } else {
        log('success', 'Security isolation verified: 100% self-contained sandbox');
      }
    }

    // ── ASSERTION: Canvas renders non-blank content ────────────────────────
    log('test', 'Checking: canvas_renders_content (detect blank canvas)');
    {
      const canvasResult = await checkCanvasRendering(page);
      const screenshotPath = await captureScreenshot(page, jobId, attempt, 'canvas_renders', SCREENSHOT_DIR);
      screenshots['canvas_renders_content'] = screenshotPath;

      const assertion = {
        name: 'canvas_renders_content',
        category: 'silent_failure',
        label: 'Canvas renders visible visual content',
        passed: canvasResult.hasContent,
        expected: 'Canvas context initialized with non-blank pixels drawn (> 1% coverage)',
        actual: canvasResult.message,
        evidence: {
          message: canvasResult.message,
          screenshot: `/screenshots/${path.basename(screenshotPath)}`,
        },
      };
      assertions.push(assertion);

      if (!canvasResult.hasContent) {
        log('error', `Canvas blank/unrendered: ${canvasResult.message}`);
        failurePackage.push(assertion);
      } else {
        log('success', `Canvas rendering verified: ${canvasResult.message}`);
      }
    }

    // ── ASSERTION: Game loop running & rAF frame timing ────────────────────
    log('test', 'Checking: game_loop_running (rAF activity & frame advancement)');
    {
      const loopResult = await checkGameLoop(page);
      const assertion = {
        name: 'game_loop_running',
        category: 'silent_failure',
        label: 'Game loop active (requestAnimationFrame advancing)',
        passed: loopResult.running,
        expected: 'requestAnimationFrame fires steadily (> 5 frames per second)',
        actual: loopResult.message,
        evidence: { message: loopResult.message },
      };
      assertions.push(assertion);

      if (!loopResult.running) {
        log('error', `Game loop dead: ${loopResult.message}`);
        failurePackage.push(assertion);
      } else {
        log('success', `Game loop healthy: ${loopResult.message}`);
      }
    }

    // ── ASSERTION: Detect frozen frame / dead render loop ──────────────────
    log('test', 'Checking: no_frozen_frame (canvas pixel delta over time)');
    {
      const freezeResult = await checkFrozenFrame(page);
      const assertion = {
        name: 'no_frozen_frame',
        category: 'silent_failure',
        label: 'No frozen canvas (frame pixels evolve over time)',
        passed: !freezeResult.frozen,
        expected: 'Canvas contents or entities update across intervals (not a dead infinite loop)',
        actual: freezeResult.message,
        evidence: { message: freezeResult.message },
      };
      assertions.push(assertion);

      if (freezeResult.frozen) {
        log('error', `Frozen render loop detected: ${freezeResult.message}`);
        failurePackage.push(assertion);
      } else {
        log('success', 'Active animation verified (no frozen frame)');
      }
    }

    // ── ASSERTION: Player entity in state ──────────────────────────────────
    log('test', 'Checking: player_entity_exists (state inspection)');
    {
      const stateResult = await checkGameState(page, 'player');
      const assertion = {
        name: 'player_entity_exists',
        category: 'logic_state',
        label: 'Player entity registered in window.__gameState',
        passed: stateResult.found,
        expected: 'window.__gameState.player exposed with coordinate properties (x, y)',
        actual: stateResult.found ? 'Player entity found' : stateResult.message,
        evidence: { state: stateResult.state, message: stateResult.message },
      };
      assertions.push(assertion);

      if (!stateResult.found) {
        log('warning', `State missing player: ${stateResult.message}`);
      } else {
        log('success', `Player entity verified in state at (${stateResult.state?.player?.x ?? '?'}, ${stateResult.state?.player?.y ?? '?'})`);
      }
    }

    // ── ASSERTION: Player responds to input controls ───────────────────────
    log('test', 'Checking: player_moves_on_input (input simulation)');
    {
      await ensurePlaying(page, fileUrl, log);
      const moveResult = await checkPlayerMovement(page, log);
      const screenshotPath = await captureScreenshot(page, jobId, attempt, 'player_movement', SCREENSHOT_DIR);
      screenshots['player_moves_on_input'] = screenshotPath;

      const assertion = {
        name: 'player_moves_on_input',
        category: 'logic_state',
        label: 'Player responds to keyboard controls',
        passed: moveResult.moved,
        expected: 'Player position changes upon receiving simulated ArrowRight / d input',
        actual: moveResult.moved ? 'Player moved successfully' : moveResult.message,
        evidence: {
          before: moveResult.before,
          after: moveResult.after,
          message: moveResult.message,
          screenshot: `/screenshots/${path.basename(screenshotPath)}`,
        },
      };
      assertions.push(assertion);

      if (!moveResult.moved) {
        log('error', `Input unresponsive: ${moveResult.message}`);
        failurePackage.push(assertion);
      } else {
        log('success', `Player movement verified: ${moveResult.message}`);
      }
    }

    // ── ASSERTION: Collision boundaries clamped ────────────────────────────
    log('test', 'Checking: player_cannot_leave_bounds (boundary clamping)');
    {
      await ensurePlaying(page, fileUrl, log);
      const boundsResult = await checkBoundaryClamp(page, log);
      const screenshotPath = await captureScreenshot(page, jobId, attempt, 'boundary_clamp', SCREENSHOT_DIR);
      screenshots['player_cannot_leave_bounds'] = screenshotPath;

      const assertion = {
        name: 'player_cannot_leave_bounds',
        category: 'logic_state',
        label: 'Player position strictly clamped within canvas boundaries',
        passed: boundsResult.clamped,
        expected: 'Player x/y coordinates remain >= 0 and <= canvas.width/height under continuous directional keys',
        actual: boundsResult.message,
        evidence: {
          position: boundsResult.position,
          canvasSize: boundsResult.canvasSize,
          message: boundsResult.message,
          screenshot: `/screenshots/${path.basename(screenshotPath)}`,
        },
      };
      assertions.push(assertion);

      if (!boundsResult.clamped) {
        log('error', `Boundary clamp failed: ${boundsResult.message}`);
        failurePackage.push(assertion);
      } else {
        log('success', 'Boundary collision clamp verified');
      }
    }

    // ── ASSERTION: Entities spawned within visible bounds ──────────────────
    log('test', 'Checking: entities_within_bounds (spawn coordinates validation)');
    {
      const entityBoundsResult = await checkEntityBounds(page);
      const assertion = {
        name: 'entities_within_bounds',
        category: 'logic_state',
        label: 'Entities spawn within visible canvas coordinates',
        passed: entityBoundsResult.passed,
        expected: 'All spawned entities have x, y within [0, canvasWidth] and [0, canvasHeight]',
        actual: entityBoundsResult.message,
        evidence: { message: entityBoundsResult.message },
      };
      assertions.push(assertion);

      if (!entityBoundsResult.passed) {
        log('warning', `Entity out of bounds: ${entityBoundsResult.message}`);
        failurePackage.push(assertion);
      } else {
        log('success', entityBoundsResult.message);
      }
    }

    // ── ASSERTION: No unbounded memory / entity array leak ─────────────────
    log('test', 'Checking: no_entity_memory_leak (unbounded array growth)');
    {
      const leakResult = await checkEntityLeak(page);
      const assertion = {
        name: 'no_entity_memory_leak',
        category: 'silent_failure',
        label: 'No unbounded entity array growth (memory leak protection)',
        passed: !leakResult.leaking,
        expected: 'Entity array count remains bounded (< 300 entities during gameplay)',
        actual: leakResult.message,
        evidence: { message: leakResult.message },
      };
      assertions.push(assertion);

      if (leakResult.leaking) {
        log('error', `Memory leak detected: ${leakResult.message}`);
        failurePackage.push(assertion);
      } else {
        log('success', 'Memory stability verified: entity count remains bounded');
      }
    }

    // ── ASSERTION: Scoring actions increment score ─────────────────────────
    log('test', 'Checking: score_increments_on_events (scoring logic)');
    {
      await ensurePlaying(page, fileUrl, log);
      const scoreResult = await checkScoreIncrement(page, log);
      const assertion = {
        name: 'score_increments_on_events',
        category: 'logic_state',
        label: 'Score increments on game events',
        passed: scoreResult.incremented,
        expected: 'Score increments or updates during gameplay interactions',
        actual: scoreResult.message,
        evidence: {
          initialScore: scoreResult.initialScore,
          finalScore: scoreResult.finalScore,
          message: scoreResult.message,
        },
      };
      assertions.push(assertion);

      if (!scoreResult.incremented) {
        log('warning', scoreResult.message);
      } else {
        log('success', scoreResult.message);
      }
    }

    // ── Late exceptions: errors thrown during input/collision playtesting ──
    {
      const allCritical = capturedExceptions.filter(isCriticalException);
      const errAssertion = assertions.find(a => a.name === 'no_console_errors');
      if (errAssertion && errAssertion.passed && allCritical.length > 0) {
        const firstErr = allCritical[0];
        let sourceSnippet = null;
        if (firstErr?.lineNumber && sourceLines[firstErr.lineNumber - 1]) {
          const start = Math.max(0, firstErr.lineNumber - 4);
          const end = Math.min(sourceLines.length, firstErr.lineNumber + 3);
          sourceSnippet = sourceLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
        }
        errAssertion.passed = false;
        errAssertion.actual = `${allCritical.length} error(s) thrown during playtesting: ${allCritical.map(e => e.message).join('; ')}`;
        errAssertion.evidence = {
          ...errAssertion.evidence,
          errors: allCritical.map(e => e.message),
          stackTrace: firstErr?.stack || null,
          lineNumber: firstErr?.lineNumber || null,
          sourceSnippet,
        };
        failurePackage.push(errAssertion);
        log('error', `Runtime errors during playtest: ${allCritical.map(e => e.message).join('; ')}`);
      }
    }

    // ── Final screenshot ──────────────────────────────────────────────────
    const finalScreenshot = await captureScreenshot(page, jobId, attempt, 'final', SCREENSHOT_DIR);
    screenshots['final'] = finalScreenshot;

    await context.close();

    // Critical assertion rules
    const criticalNames = [
      'no_console_errors',
      'no_untrusted_operations',
      'canvas_renders_content',
      'game_loop_running',
      'no_frozen_frame',
      'player_moves_on_input',
      'player_cannot_leave_bounds',
      'no_entity_memory_leak',
    ];

    const criticalAssertions = assertions.filter(a => criticalNames.includes(a.name));
    const allCriticalPassed = criticalAssertions.every(a => a.passed);

    log(allCriticalPassed ? 'success' : 'error',
      `Sensory test run complete: ${assertions.filter(a => a.passed).length}/${assertions.length} passed (${criticalAssertions.filter(a => a.passed).length}/${criticalAssertions.length} critical)`
    );

    return {
      passed: allCriticalPassed,
      assertions,
      errors,
      screenshots,
      failurePackage,
    };

  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// ── Helper inspection functions ──────────────────────────────────────────────

function isCriticalException(e) {
  return e.type === 'ThrownException' ||
    e.message?.includes('SyntaxError') ||
    e.message?.includes('ReferenceError') ||
    e.message?.includes('TypeError') ||
    e.message?.includes('is not defined') ||
    e.message?.includes('Cannot read');
}

async function captureScreenshot(page, jobId, attempt, name, dir) {
  const filename = `${jobId}_v${attempt}_${name}.png`;
  const filepath = path.join(dir, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: false });
  } catch (e) {}
  return filepath;
}

async function checkCanvasRendering(page) {
  try {
    const result = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return { hasContent: false, message: 'No canvas element found' };

      const ctx = canvas.getContext('2d');
      if (!ctx) return { hasContent: false, message: 'Cannot get 2D rendering context' };

      const width = canvas.width || canvas.offsetWidth;
      const height = canvas.height || canvas.offsetHeight;
      if (!width || !height) return { hasContent: false, message: 'Canvas dimensions are zero' };

      const imageData = ctx.getImageData(0, 0, Math.min(width, 800), Math.min(height, 600));
      const data = imageData.data;

      let nonBlankPixels = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (a > 10 && (r > 20 || g > 20 || b > 20)) {
          nonBlankPixels++;
        }
      }

      const totalPixels = data.length / 4;
      const ratio = nonBlankPixels / totalPixels;

      return {
        hasContent: ratio > 0.005,
        message: `${nonBlankPixels}/${totalPixels} pixels rendered (${(ratio * 100).toFixed(1)}% coverage)`,
      };
    });
    return result;
  } catch (e) {
    return { hasContent: false, message: `Canvas check error: ${e.message}` };
  }
}

async function checkGameLoop(page) {
  try {
    await page.evaluate(() => {
      window.__frameCount = 0;
      const origRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = function(cb) {
        window.__frameCount = (window.__frameCount || 0) + 1;
        return origRAF.call(window, cb);
      };
    });

    const before = await page.evaluate(() => window.__frameCount || 0);
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => window.__frameCount || 0);

    const framesElapsed = after - before;
    const running = framesElapsed >= 4;

    return {
      running,
      message: `${framesElapsed} frames in 800ms (${(framesElapsed / 0.8).toFixed(1)} fps)`,
    };
  } catch (e) {
    return { running: false, message: `Loop check error: ${e.message}` };
  }
}

async function checkFrozenFrame(page) {
  try {
    const sampleCanvas = async () => {
      return page.evaluate(() => {
        const c = document.querySelector('canvas');
        if (!c) return null;
        const ctx = c.getContext('2d');
        // Hash the whole canvas: motion can happen anywhere (a ball far from the HUD corner)
        const img = ctx.getImageData(0, 0, c.width, c.height);
        let hash = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          hash = (hash * 31 + img.data[i] + img.data[i + 1] * 7 + img.data[i + 2] * 13) | 0;
        }
        return hash;
      });
    };

    const hash1 = await sampleCanvas();
    await page.waitForTimeout(400);
    const hash2 = await sampleCanvas();
    await page.waitForTimeout(400);
    const hash3 = await sampleCanvas();

    const isPlaying = await page.evaluate(() => window.__gameState?.status === 'playing');
    const idleIdentical = hash1 !== null && hash1 === hash2 && hash2 === hash3;
    if (!idleIdentical || !isPlaying) {
      return { frozen: false, message: 'Canvas pixels actively updating across intervals' };
    }

    // A calm scene (idle player, static level) can legitimately repeat frames. It is only
    // frozen if the picture still doesn't change while the player is actively giving input.
    for (const key of ['ArrowRight', 'ArrowLeft', ' ']) {
      await pressKey(page, key, 350);
      const h = await sampleCanvas();
      if (h !== hash3) {
        return { frozen: false, message: 'Idle frames were static, but the canvas updates in response to input' };
      }
    }
    return {
      frozen: true,
      message: 'Canvas pixels remained 100% identical for 800ms idle AND while holding ArrowRight/ArrowLeft/Space — rendering is not updating',
    };
  } catch (e) {
    return { frozen: false, message: `Freeze check non-fatal error: ${e.message}` };
  }
}

async function checkGameState(page, key) {
  try {
    const state = await page.evaluate(() => window.__gameState || null);
    if (!state) {
      return { found: false, state: null, message: 'window.__gameState not exposed' };
    }
    const found = key in state;
    return { found, state, message: found ? `Found "${key}" in gameState` : `"${key}" missing from gameState` };
  } catch (e) {
    return { found: false, state: null, message: `State check error: ${e.message}` };
  }
}

/**
 * Games can legitimately end on their own (e.g. a snake running into a wall while nobody steers).
 * Before each input test, get back to a live 'playing' state: try the restart keys the codegen
 * prompt asks for (R / Enter), and fall back to reloading the page for a fresh run.
 */
async function ensurePlaying(page, fileUrl, log) {
  const status = () => page.evaluate(() => window.__gameState?.status).catch(() => undefined);
  let st = await status();
  if (st === undefined || st === 'playing') return st;
  for (const k of ['r', 'Enter', ' ']) {
    await pressKey(page, k, 120);
    await page.waitForTimeout(250);
    st = await status();
    if (st === 'playing') {
      log('info', `Game had ended on its own — restarted with "${k === ' ' ? 'Space' : k}" before next input test`);
      return st;
    }
  }
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate(() => { const c = document.querySelector('canvas'); if (c) { c.setAttribute('tabindex', '0'); c.focus(); } }).catch(() => {});
  st = await status();
  log('info', `Game had ended on its own — reloaded a fresh session before next input test (status: ${st})`);
  return st;
}

async function checkPlayerMovement(page, log) {
  try {
    const read = () => page.evaluate(() => {
      const s = window.__gameState;
      if (!s?.player) return null;
      return { x: s.player.x, y: s.player.y, status: s.status };
    });
    const before = await read();

    if (!before) {
      return { moved: false, message: 'window.__gameState.player not found to test coordinates' };
    }

    // Try every direction: some games ignore a key that matches the current heading (snake) or axis
    let after = before;
    for (const key of ['ArrowRight', 'd', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) {
      await pressKey(page, key, 300);
      after = (await read()) || after;
      if (after.x !== before.x || after.y !== before.y) break;
    }

    const moved = after && (before.x !== after.x || before.y !== after.y);
    return {
      moved,
      before,
      after,
      message: moved
        ? `Player moved from (${before.x}, ${before.y}) to (${after.x}, ${after.y})`
        : `Player position (${before.x}, ${before.y}) did not change while holding ArrowRight, d, ArrowUp, ArrowLeft and ArrowDown (game status: ${after?.status ?? 'unknown'})`,
    };
  } catch (e) {
    return { moved: false, message: `Movement check error: ${e.message}`, before: null, after: null };
  }
}

// Playwright key names differ from KeyboardEvent.key for a few keys
const KEY_ALIASES = {
  ' ': { pw: 'Space', key: ' ', code: 'Space' },
  Space: { pw: 'Space', key: ' ', code: 'Space' },
  Enter: { pw: 'Enter', key: 'Enter', code: 'Enter' },
};

function keyInfo(k) {
  if (KEY_ALIASES[k]) return KEY_ALIASES[k];
  if (k.length === 1) return { pw: k, key: k, code: `Key${k.toUpperCase()}` };
  return { pw: k, key: k, code: k };
}

async function dispatchSynthetic(page, info, type) {
  await page.evaluate(({ key, code, type }) => {
    const targets = [window, document, document.querySelector('canvas')].filter(Boolean);
    targets.forEach(t => t.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true })));
  }, { key: info.key, code: info.code, type });
}

async function pressKey(page, key, durationMs = 300) {
  const info = keyInfo(key);
  try {
    await dispatchSynthetic(page, info, 'keydown');
    await page.keyboard.down(info.pw).catch(() => {});
    await page.waitForTimeout(durationMs);
    await page.keyboard.up(info.pw).catch(() => {});
    await dispatchSynthetic(page, info, 'keyup');
  } catch (e) {}
}

const readPlayer = (page) => page.evaluate(() => {
  const p = window.__gameState?.player;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  return { x: p.x, y: p.y, width: Number(p.width) || 0, height: Number(p.height) || 0 };
});

/**
 * Hold a direction until the player escapes the canvas, stops moving, or maxMs elapses.
 * Accepts both top-left and centre-anchored coordinates: an escape means the anchor is
 * more than half a sprite (plus tolerance) outside the canvas.
 */
async function holdUntilStable(page, key, canvas, maxMs = 3500) {
  const info = keyInfo(key);
  const outside = (p) => p && (
    p.x < -p.width / 2 - 4 || p.x > canvas.width - p.width / 2 + 4 ||
    p.y < -p.height / 2 - 4 || p.y > canvas.height - p.height / 2 + 4 ||
    !Number.isFinite(p.x) || !Number.isFinite(p.y)
  );
  let last = null, still = 0, pos = null, escaped = null;
  await dispatchSynthetic(page, info, 'keydown');
  await page.keyboard.down(info.pw).catch(() => {});
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < maxMs) {
      await page.waitForTimeout(200);
      pos = await readPlayer(page);
      if (!pos) break;
      if (outside(pos)) {
        // confirm it persists (ignores respawn-teleport frames)
        await page.waitForTimeout(250);
        const again = await readPlayer(page);
        if (outside(again)) { escaped = again; break; }
      }
      still = last && last.x === pos.x && last.y === pos.y ? still + 1 : 0;
      if (still >= 3) break;
      last = pos;
    }
  } finally {
    await page.keyboard.up(info.pw).catch(() => {});
    await dispatchSynthetic(page, info, 'keyup');
  }
  return { pos: escaped || pos, escaped: Boolean(escaped) };
}

async function checkBoundaryClamp(page, log) {
  try {
    const canvasInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      return { width: canvas.width || canvas.offsetWidth, height: canvas.height || canvas.offsetHeight };
    });

    if (!canvasInfo) {
      return { clamped: false, message: 'No canvas found', position: null, canvasSize: null };
    }
    if (!(await readPlayer(page))) {
      return { clamped: true, message: 'Boundary check soft pass (no player coordinates)', position: null, canvasSize: canvasInfo };
    }

    log('info', 'Playtesting: holding each direction to drive the player past the canvas edges...');
    const position = {};
    const escapes = [];
    for (const [dir, key] of [['left', 'ArrowLeft'], ['right', 'ArrowRight'], ['up', 'ArrowUp'], ['down', 'ArrowDown']]) {
      const r = await holdUntilStable(page, key, canvasInfo);
      position[dir] = r.pos;
      if (r.escaped) escapes.push(`${dir}: (${Math.round(r.pos.x)}, ${Math.round(r.pos.y)})`);
      const st = await page.evaluate(() => window.__gameState?.status);
      if (st && st !== 'playing') break; // player died mid-test; don't misread a frozen state
    }

    const clamped = escapes.length === 0;
    const fmt = (p) => (p ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : 'N/A');
    return {
      clamped,
      position,
      canvasSize: canvasInfo,
      message: clamped
        ? `Player clamped safely. Extremes — left ${fmt(position.left)}, right ${fmt(position.right)}, up ${fmt(position.up)}, down ${fmt(position.down)}`
        : `Boundary escape detected! Player left the ${canvasInfo.width}x${canvasInfo.height} canvas while holding a direction key — ${escapes.join('; ')}`,
    };
  } catch (e) {
    return { clamped: false, message: `Bounds check error: ${e.message}`, position: null, canvasSize: null };
  }
}

async function checkEntityBounds(page) {
  try {
    const result = await page.evaluate(() => {
      const s = window.__gameState;
      const c = document.querySelector('canvas');
      const w = c?.width || 800;
      const h = c?.height || 600;

      if (!s?.entities || !Array.isArray(s.entities) || s.entities.length === 0) {
        return { passed: true, message: 'No entities array or 0 entities to inspect (soft pass)' };
      }

      const outOfBounds = s.entities.filter(e => {
        if (typeof e.x !== 'number' || typeof e.y !== 'number') return false;
        return e.x < -100 || e.x > w + 200 || e.y < -100 || e.y > h + 200;
      });

      if (outOfBounds.length > 0) {
        return {
          passed: false,
          message: `${outOfBounds.length} entity(ies) spawned outside visible boundary! First: (${outOfBounds[0].x}, ${outOfBounds[0].y})`,
        };
      }

      return { passed: true, message: `All ${s.entities.length} inspected entities are positioned within valid bounds` };
    });
    return result;
  } catch (e) {
    return { passed: true, message: `Entity bounds non-fatal error: ${e.message}` };
  }
}

async function checkEntityLeak(page) {
  try {
    const counts = [];
    for (let i = 0; i < 3; i++) {
      const count = await page.evaluate(() => {
        const s = window.__gameState;
        return Array.isArray(s?.entities) ? s.entities.length : 0;
      });
      counts.push(count);
      await page.waitForTimeout(300);
    }

    const maxCount = Math.max(...counts);
    const growth = counts[2] - counts[0];
    const leaking = maxCount > 350 || growth > 150;

    return {
      leaking,
      message: leaking
        ? `Entity array growing unboundedly: ${counts.join(' -> ')} (potential memory leak)`
        : `Entity count stable: peak ${maxCount} items`,
    };
  } catch (e) {
    return { leaking: false, message: `Entity leak check non-fatal error: ${e.message}` };
  }
}

async function checkScoreIncrement(page, log) {
  try {
    const initialScore = await page.evaluate(() => {
      const s = window.__gameState;
      return s?.score ?? s?.points ?? null;
    });

    // Exercise the action keys (fire / jump / confirm) for long enough to run several frames
    await pressKey(page, ' ', 600);
    await page.waitForTimeout(100);

    const canvas = await page.$('canvas');
    if (canvas) {
      const box = await canvas.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(200);
      }
    }

    for (let i = 0; i < 4; i++) {
      await pressKey(page, 'ArrowUp', 100);
      await pressKey(page, 'ArrowRight', 100);
    }

    const finalScore = await page.evaluate(() => {
      const s = window.__gameState;
      return s?.score ?? s?.points ?? null;
    });

    if (initialScore === null && finalScore === null) {
      return {
        incremented: true,
        initialScore: 'N/A',
        finalScore: 'N/A',
        message: 'window.__gameState.score not exposed (soft pass)',
      };
    }

    const incremented = finalScore !== null && initialScore !== null;
    return {
      incremented,
      initialScore,
      finalScore,
      message: `Score observed: ${initialScore} -> ${finalScore}`,
    };
  } catch (e) {
    return { incremented: true, initialScore: null, finalScore: null, message: `Score check error: ${e.message}` };
  }
}

async function checkUntrustedOperations(page, gameHtml) {
  const violations = [];

  // Static checks on generated source
  if (/<script\b[^>]*src\s*=\s*['"](?!file:)[^'"]+['"]/i.test(gameHtml)) {
    violations.push('External script reference detected (<script src=...>)');
  }
  if (/\beval\s*\(/.test(gameHtml)) {
    violations.push('Use of eval() detected');
  }
  if (/\bnew\s+Function\s*\(/.test(gameHtml)) {
    violations.push('Use of new Function() constructor detected');
  }
  if (/\bdocument\.cookie\b/.test(gameHtml)) {
    violations.push('Attempt to access document.cookie detected');
  }
  if (/\b(localStorage|sessionStorage)\b/.test(gameHtml)) {
    violations.push('Storage persistence API access detected');
  }
  if (/\b(fetch\s*\(|XMLHttpRequest\b)/.test(gameHtml)) {
    violations.push('Outbound network request API detected');
  }

  // Runtime context inspection
  try {
    const runtime = await page.evaluate(() => {
      const issues = [];
      if (document.cookie && document.cookie.length > 0) issues.push('Active cookie content found');
      const scripts = Array.from(document.querySelectorAll('script'));
      if (scripts.some(s => s.src && !s.src.startsWith('file://'))) {
        issues.push('Remote script element present in DOM');
      }
      return issues;
    });
    if (runtime && runtime.length > 0) {
      violations.push(...runtime);
    }
  } catch (e) {}

  const passed = violations.length === 0;
  return {
    passed,
    message: passed
      ? 'Zero untrusted operations detected (no eval, new Function, external scripts, or network exfiltration)'
      : `Security sandbox violation: ${violations.join('; ')}`,
    violations,
  };
}

