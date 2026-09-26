# 🎮 Game Architect — How It Works (Simple Guide)

*A guide written for Grade 8 students. Read it, try it, then explain it to a friend!*

---

## 1. What does this project do? (in one sentence)

You **type an idea for a game** in plain English, and the computer **writes the game, plays it to check it, fixes its own mistakes**, and then gives you a game you can play in your browser.

Example: you type *"a snake game where you eat apples to grow"*. About a minute later, you are playing that snake game.

---

## 2. The big idea: a robot team

Imagine a small team of robots making a game for you:

| Robot | Its job | Real name in the code |
|---|---|---|
| 🧠 **The Planner** | Reads your idea and writes a plan: game name, rules, how you win, how you lose | *Spec generation* |
| ✍️ **The Coder** | Writes the actual game code (HTML + JavaScript) | *Code synthesis* |
| 🕹️ **The Tester** | Opens the game in an invisible browser and plays it with fake key presses | *Playwright playtest bot* |
| 🔧 **The Fixer** | Reads the tester's bug report and repairs the code | *Self-healing* |

The Planner, Coder and Fixer are all the same AI: **Google Gemini** (model `gemini-3.8-flash`).
The Tester is **not** an AI. It is a normal program that follows fixed rules, so it can't be tricked.

---

## 3. The 6 stages (step by step)

```
  Your idea
     │
     ▼
 ① PLAN ──► ② WRITE CODE ──► ③ + ④ TEST THE GAME
                                   │
                    all tests pass?│
               ┌──── NO ───────────┤
               ▼                   │ YES
          ⑤ FIX THE BUG            ▼
               │              ⑥ VERIFIED ✅
               └──► test again     (you can play!)
```

1. **Plan (Spec).** Gemini turns your sentence into a clear plan, for example:
   *Title: "Neon Serpent". Controls: arrow keys. Win: eat 20 apples. Lose: hit a wall.*
2. **Write code.** Gemini writes one complete web page (an HTML file) that contains the whole game.
3. **Sensory check.** The Tester opens the game in a hidden Chrome browser (you can't see it) and watches it: does it crash? Does it draw anything? Is it moving?
4. **Playtest bot.** The Tester "presses" arrow keys and Space to see if the player really moves, and tries to push the player off the screen.
5. **Self-healing.** If any test fails, the Tester writes a **bug report** (what was expected, what actually happened, and the error message). Gemini reads the report and sends back fixed code. Then everything is tested **again**. This repeats up to 5 times.
6. **Verified.** When every important test passes, the game is shown to you with a green ✅ **VERIFIED PLAYABLE** badge.

> 💡 **Why is this cool?** Normally a human programmer writes code, tests it, finds bugs and fixes them. Here the computer does that whole loop **by itself**. That's what "autonomous" means.

---

## 4. The 11 tests the robot tester runs

Think of these as a checklist a game inspector ticks off:

| # | Test | Question it answers |
|---|---|---|
| 1 | No errors | Did the game crash or show a red error? |
| 2 | Safe code | Does the game try anything unsafe, like using the internet or hidden storage? |
| 3 | Draws something | Is the screen blank, or is there a picture? |
| 4 | Game loop running | Is the game updating about 60 times a second? |
| 5 | Not frozen | Does the picture change over time, or when you press keys? |
| 6 | Player exists | Can the tester find the player in the game? |
| 7 | Player moves | When arrow keys are pressed, does the player move? |
| 8 | Stays on screen | If you hold a direction key, does the player stop at the edge instead of flying off? |
| 9 | Things spawn on screen | Do enemies and coins appear inside the visible area? |
| 10 | No memory leak | Does the game keep creating objects forever until it slows down? |
| 11 | Score works | Does the game keep track of a score? |

**How does the tester "see" inside the game?** Every game must share its information in a special variable called `window.__gameState` (player position, score, and whether the game is `playing`, `won` or `lost`). It's like the game wearing a name tag that the tester can read.

---

## 5. A real example of self-healing

We tested the Fixer on purpose with a broken spaceship game that had 2 hidden bugs:

- **Bug 1:** pressing Space called a function that didn't exist, so the game **crashed**.
- **Bug 2:** the ship could fly **off the edge of the screen**.

What happened:

1. The Tester found both bugs: *"spawnBulletFromShip is not defined"* and *"Player left the canvas at x = -166"*.
2. Gemini read the report and explained: *"The code calls spawnBulletFromShip, but this function was never written… the player position is never limited to the screen."*
3. Gemini wrote the missing function and added the edge limit.
4. The Tester played the game again: **11 out of 11 tests passed** ✅

---

## 6. What is in each folder?

```
gensis/
├── client/              ← the WEBSITE you see (made with React)
│   └── src/components/  ← each part of the screen (console, game preview, arena…)
├── server/              ← the ENGINE that does the work (Node.js)
│   ├── services/
│   │   ├── gemini.js             ← talks to Google Gemini (the AI)
│   │   ├── pipeline.js           ← runs the 6 stages in order
│   │   ├── playwright-runner.js  ← the robot tester (the 11 tests)
│   │   └── arena.js              ← two AI models race to build the same game
│   ├── games/           ← every game that was made is saved here as an .html file
│   ├── screenshots/     ← pictures the tester took while playing
│   ├── scripts/         ← handy commands for testing (see section 8)
│   └── .env             ← SECRET settings, like the API key (never share this!)
└── README.md            ← the technical guide
```

**Client vs server:**
- The **client** is like a restaurant's dining room: what you see and click.
- The **server** is like the kitchen: where the real cooking (AI + testing) happens.
- They talk using web requests. The server sends live updates to the page, which is why you see the log messages appear one by one (this is called **SSE**, Server-Sent Events).

---

## 7. How to use it

### Start it (one time setup is already done on this computer)

Open **two** terminals.

**Terminal 1: start the engine (server)**
```bash
cd server
npm start
```

**Terminal 2: start the website (client)**
```bash
cd client
npm run dev
```

Then open the website address shown in Terminal 2 (normally `http://localhost:5188`) in your browser.

> ⚠️ On this computer, another copy of the project is already using ports 3001 and 5188, so this copy was started on **http://localhost:5288** instead. If a port is "busy", that is the reason.

### Make a game

1. Click **Studio** at the top.
2. Type your game idea, for example: *"a car dodging traffic on a 3-lane road"*.
3. Press **Generate**.
4. Watch the **Agent Console**: it shows every stage live.
5. Watch the **Test Results**: green ✓ means passed, red ✗ means the Fixer will try again.
6. When you see **VERIFIED PLAYABLE**, click the game and play with the **arrow keys** and **Space**.
7. Click **Download Game** to keep the game as a single `.html` file. It works offline in any browser!

### Other pages

| Page | What you can do there |
|---|---|
| **Arena** | Two Gemini models (3.8 Flash vs 3.7 Flash) build the same game at the same time. Which one wins? |
| **Games** | See all games made so far, replay them, or "remix" an idea |
| **Labs → Self-Healing Lab** | Inject a bug on purpose and watch how it's detected |
| **Labs → Retro Sound Lab** | Make 8-bit sound effects |
| **Exhibits** | Fun animated art pages |

### Tips for good prompts ✍️

- ✅ Say **what the player controls**: *"you control a paddle at the bottom"*
- ✅ Say **how to win or lose**: *"lose when the ball falls"*
- ✅ Keep it **2D and simple**: dodge, collect, shoot, snake, breakout, flappy-style
- ❌ Avoid huge ideas like *"make Minecraft"*. It's one small web page, not a giant game.

---

## 8. Test commands (for curious students)

Run these inside the `server` folder:

| Command | What it proves |
|---|---|
| `npm run test:synthetic` | The tester really catches 4 kinds of bugs (no AI needed) |
| `node scripts/heal-test.js` | A broken game gets fixed by Gemini automatically |
| `node scripts/generate.js "a snake game"` | Makes a whole game without opening the website |

---

## 9. Things that can go wrong (and why)

| What you see | What it means |
|---|---|
| **"high demand" / 503** | Google's AI is busy. The engine automatically waits and tries other Gemini models. |
| **"quota exceeded" / 429** | The free daily limit is used up. Try again tomorrow. |
| **⚠ TEMPLATE — NOT AI-GENERATED** | Gemini could not answer at all, so a built-in sample game is shown instead. It was **not** made from your idea. |
| **Max self-heal cycles reached** | The Fixer tried 5 times and couldn't fix everything. Try rewording your idea more simply. |

---

## 10. Word list (glossary)

| Word | Simple meaning |
|---|---|
| **AI model / LLM** | A computer program trained on lots of text that can write text and code |
| **Gemini** | Google's AI model family. We use `gemini-3.8-flash` |
| **API key** | A secret password that lets our program use Gemini. **Keep it secret!** |
| **Prompt** | The instruction or idea you type in |
| **HTML / JavaScript** | The languages web pages and browser games are written in |
| **Canvas** | The drawing area on a web page where the game is drawn |
| **Game loop** | Code that runs about 60 times per second: move things, check hits, draw the picture |
| **Bug** | A mistake in code |
| **Headless browser** | A real Chrome browser running invisibly, controlled by a program |
| **Self-healing** | The program finds its own bugs and fixes them |
| **Autonomous** | Works by itself without a human helping at every step |

---

## 11. Explain it to a friend in 30 seconds 🗣️

> *"You type a game idea. An AI called Gemini writes the game's code. Then a robot tester secretly plays the game in a hidden browser, pressing keys and checking 11 things, like 'does it crash?' and 'can the player leave the screen?'. If something's broken, it sends a bug report back to the AI, which fixes the code, and it tests again. When everything passes, you get a working game you can play and download!"*
