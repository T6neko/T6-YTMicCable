require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const sea = require('node:sea');
const { spawn, spawnSync } = require('child_process');

// When bundled into a standalone .exe via Node's Single Executable
// Application feature, __dirname no longer points at real files on disk —
// public/index.html and scripts/set-app-volume.ps1 are embedded instead and
// must be read via sea.getAsset().
const IS_SEA = sea.isSea();

// A grab-bag of songs widely familiar in Japan (J-pop hits, anime openings,
// Vocaloid classics) used by the "random" console command below.
const JAPANESE_SONG_PICKS = [
  '米津玄師 Lemon',
  'YOASOBI 夜に駆ける',
  'YOASOBI アイドル',
  'Official髭男dism Pretender',
  'Official髭男dism 宿命',
  'あいみょん マリーゴールド',
  'あいみょん 猫',
  '優里 ドライフラワー',
  'Ado うっせぇわ',
  'Ado 新時代',
  'King Gnu 白日',
  'King Gnu 一途',
  'DA PUMP U.S.A.',
  'ゆず 栄光の架橋',
  '鬼滅の刃 紅蓮華 LiSA',
  '進撃の巨人 紅蓮の弓矢',
  '新世紀エヴァンゲリオン 残酷な天使のテーゼ',
  'RADWIMPS 前前前世',
  'RADWIMPS スパークル',
  '打上花火 DAOKO 米津玄師',
  '初音ミク 千本桜',
  '初音ミク ワールドイズマイン',
  '初音ミク メルト',
  'ハチ 砂の惑星',
  'いきものがかり 花は咲く',
  'いきものがかり ありがとう',
  'スピッツ チェリー',
  'スピッツ ロビンソン',
  'MISIA 逢いたくていま',
  '宇多田ヒカル First Love',
  '宇多田ヒカル 花束を君に',
  'aiko カブトムシ',
  'コブクロ 桜',
  '西野カナ トリセツ',
  'back number 高嶺の花子さん',
  'back number クリスマスソング',
  'てぃんくる 千と千尋の神隠し いつも何度でも',
  '美空ひばり 川の流れのように',
  'サザンオールスターズ 勝手にシンドバッド',
  'ドラえもん のび太の恋人',
  'ちびまる子ちゃん おどるポンポコリン',
  'サザエさん エンディング',
  'アンパンマン アンパンマンのマーチ',
];

function pickRandomJapaneseSong() {
  return JAPANESE_SONG_PICKS[Math.floor(Math.random() * JAPANESE_SONG_PICKS.length)];
}

const app = express();
const PORT = process.env.PORT || 3535;
const ACCESS_CODE = process.env.ACCESS_CODE || '';

app.use(express.json());

// When exposed to the internet (e.g. via cloudflared), require a shared
// access code on every API call so strangers who stumble on the URL can't
// hijack playback. Set ACCESS_CODE in .env to enable; leave unset for
// LAN-only / trusted use.
app.use('/api', (req, res, next) => {
  if (!ACCESS_CODE) return next();
  const provided = req.get('x-access-code') || req.query.code;
  if (provided === ACCESS_CODE) return next();
  res.status(401).json({ error: 'Invalid or missing access code' });
});

if (IS_SEA) {
  const indexHtml = sea.getAsset('index_html', 'utf8');
  app.get('/', (req, res) => res.type('html').send(indexHtml));
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

// --- Player state ---
const queue = []; // { title, url }
let current = null; // { title, url }
let ytdlpProc = null;
let ffplayProc = null;
let status = 'idle'; // idle | loading | playing
let volume = Number(process.env.DEFAULT_VOLUME) || 50; // 0-100, passed to ffplay
let playGeneration = 0; // guards against a killed playback's late 'close' event advancing the queue a second time
let randomLoopEnabled = false; // when true, an empty queue is refilled with a random pick instead of going idle

function stopCurrent() {
  playGeneration++; // invalidate any in-flight 'close' handlers from the killed processes
  if (ytdlpProc) {
    ytdlpProc.kill('SIGKILL');
    ytdlpProc = null;
  }
  if (ffplayProc) {
    ffplayProc.kill('SIGKILL');
    ffplayProc = null;
  }
}

function isUrl(str) {
  return /^https?:\/\//i.test(str);
}

// Searches the user's winget install location for a given exe when it isn't
// on PATH yet (common right after `winget install`, since an already-open
// terminal keeps the PATH it had at launch until reopened).
function findInWinGetPackages(exeName) {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (!fs.existsSync(base)) return null;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === exeName.toLowerCase()) {
        return full;
      }
    }
  }
  return null;
}

const resolvedBinCache = {};
function resolveBinary(command, exeName) {
  if (resolvedBinCache[command]) return resolvedBinCache[command];
  const onPath = spawnSync(command, ['--version'], { stdio: 'ignore' });
  const resolved = !onPath.error ? command : (findInWinGetPackages(exeName) || command);
  resolvedBinCache[command] = resolved;
  return resolved;
}

function isBinaryAvailable(command, exeName, extraPaths = []) {
  if (!spawnSync(command, ['--version'], { stdio: 'ignore' }).error) return true;
  if (findInWinGetPackages(exeName)) return true;
  return extraPaths.some((p) => fs.existsSync(p));
}

// Required external tools this app doesn't ship with. Installed on first
// run (via winget) instead of making the user run winget commands by hand.
const REQUIRED_DEPENDENCIES = [
  {
    label: 'ffmpeg/ffplay',
    checkCmd: 'ffplay',
    exeName: 'ffplay.exe',
    wingetId: 'Gyan.FFmpeg',
  },
  {
    label: 'yt-dlp',
    checkCmd: 'yt-dlp',
    exeName: 'yt-dlp.exe',
    wingetId: 'yt-dlp.yt-dlp',
  },
  {
    label: 'cloudflared',
    checkCmd: 'cloudflared',
    exeName: 'cloudflared.exe',
    wingetId: 'Cloudflare.cloudflared',
    extraPaths: ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'],
  },
];

async function ensureDependencies() {
  const missing = REQUIRED_DEPENDENCIES.filter(
    (dep) => !isBinaryAvailable(dep.checkCmd, dep.exeName, dep.extraPaths || [])
  );
  if (missing.length === 0) return;

  console.log(`[初回セットアップ] 不足しているツールを検出: ${missing.map((d) => d.label).join(', ')}`);

  if (spawnSync('winget', ['--version'], { stdio: 'ignore' }).error) {
    console.error(
      '[初回セットアップ] winget が見つかりません。Microsoft StoreからApp Installerを導入するか、' +
      `以下を手動でインストールしてください: ${missing.map((d) => d.label).join(', ')}`
    );
    return;
  }

  for (const dep of missing) {
    console.log(`[初回セットアップ] ${dep.label} をインストールしています (winget install ${dep.wingetId})...`);
    const result = spawnSync('winget', [
      'install', '--id', dep.wingetId, '-e',
      '--accept-package-agreements', '--accept-source-agreements',
    ], { stdio: 'inherit' });

    if (result.error || result.status !== 0) {
      console.error(
        `[初回セットアップ] ${dep.label} の自動インストールに失敗しました。` +
        `手動で次を実行してください: winget install --id ${dep.wingetId} -e`
      );
    } else {
      console.log(`[初回セットアップ] ${dep.label} をインストールしました。`);
    }
  }
}

// Live volume control: ffplay itself has no way to change volume once
// running (it only reads -volume at startup, and stdin is busy carrying
// audio data). Instead we reach into Windows' own per-app volume mixer via
// the Core Audio API (ISimpleAudioVolume) and set ffplay.exe's session
// volume directly by PID — this changes the currently playing track's
// volume instantly, with no restart.
function resolvePowerShell() {
  const fallback = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  return fs.existsSync(fallback) ? fallback : 'powershell.exe';
}

let extractedVolumeScriptPath = null;
function getVolumeScriptPath() {
  if (!IS_SEA) return path.join(__dirname, 'scripts', 'set-app-volume.ps1');
  if (!extractedVolumeScriptPath) {
    // powershell.exe needs a real file, so the embedded script is written
    // out to a temp file once and reused for the life of this process.
    const content = sea.getAsset('set_app_volume_ps1', 'utf8');
    extractedVolumeScriptPath = path.join(os.tmpdir(), 'discord-music-player-set-app-volume.ps1');
    fs.writeFileSync(extractedVolumeScriptPath, content, 'utf8');
  }
  return extractedVolumeScriptPath;
}

function applyLiveVolume(pid, volumePercent) {
  const script = getVolumeScriptPath();
  spawn(resolvePowerShell(), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-ProcessId', String(pid),
    '-Volume', String(volumePercent),
  ], { stdio: 'ignore' }).on('error', (err) => {
    console.error('音量の即時反映に失敗しました (PowerShell起動エラー):', err);
  });
}

// Resolves a URL or free-text query to { title, url } using yt-dlp's metadata
// extraction (no media download). "ytsearch1:" makes yt-dlp search YouTube
// and return the single best match.
function resolveTrack(query) {
  return new Promise((resolve, reject) => {
    const input = isUrl(query) ? query : `ytsearch1:${query}`;
    const proc = spawn(resolveBinary('yt-dlp', 'yt-dlp.exe'), [
      '--no-warnings',
      '--no-playlist',
      '-j',
      input,
    ]);

    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 || !out.trim()) {
        return reject(new Error(err || `yt-dlp exited with code ${code}`));
      }
      try {
        const firstLine = out.trim().split('\n')[0];
        const info = JSON.parse(firstLine);
        resolve({ title: info.title, url: info.webpage_url });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function playNext() {
  if (queue.length === 0 && randomLoopEnabled) {
    const query = pickRandomJapaneseSong();
    console.log(`[ランダムループ] 「${query}」を検索しています...`);
    try {
      const track = await resolveTrack(query);
      queue.push(track);
      console.log(`[ランダムループ] キューに追加: ${track.title}`);
    } catch (err) {
      console.error('[ランダムループ] 曲の取得に失敗しました。別の曲を試します:', err.message || err);
      return randomLoopEnabled ? playNext() : undefined; // retry, unless the loop was turned off while we were fetching
    }
  }

  if (queue.length === 0) {
    current = null;
    status = 'idle';
    return;
  }

  current = queue.shift();
  status = 'loading';

  const generation = ++playGeneration;

  ytdlpProc = spawn(resolveBinary('yt-dlp', 'yt-dlp.exe'), [
    '--no-warnings',
    '--no-playlist',
    // The default "web" player client now requires a PO token for audio
    // formats and returns HTTP 403 without it; the "android" client still
    // serves combined formats (video+audio) without one.
    '--extractor-args', 'youtube:player_client=android',
    '-f', 'bestaudio/best',
    '-o', '-',
    current.url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffplayProc = spawn(resolveBinary('ffplay', 'ffplay.exe'), [
    '-nodisp',
    '-autoexit',
    '-loglevel', 'error',
    '-volume', String(volume),
    '-i', 'pipe:0',
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  status = 'playing';
  ytdlpProc.stdout.pipe(ffplayProc.stdin);

  // Killing either process mid-stream (skip/stop) closes the pipe while the
  // other side may still be writing; without these handlers that EPIPE/ECONNRESET
  // is unhandled and crashes the whole server.
  ytdlpProc.stdout.on('error', () => {});
  ffplayProc.stdin.on('error', () => {});

  ytdlpProc.stderr.on('data', (d) => console.error(`[yt-dlp] ${d}`));
  ffplayProc.stderr.on('data', (d) => console.error(`[ffplay] ${d}`));

  ytdlpProc.on('error', (err) => {
    console.error('yt-dlp failed to start. Is it installed and on PATH?', err);
  });

  ffplayProc.on('error', (err) => {
    console.error('ffplay failed to start. Is ffmpeg/ffplay installed and on PATH?', err);
  });

  let advanced = false;
  const advance = () => {
    if (advanced || generation !== playGeneration) return;
    advanced = true;
    ytdlpProc = null;
    ffplayProc = null;
    playNext();
  };

  ytdlpProc.on('close', () => {
    if (generation === playGeneration) ytdlpProc = null;
  });
  ffplayProc.on('close', advance);
}

async function queueTrack(query) {
  const track = await resolveTrack(query);
  queue.push(track);
  if (!current) {
    playNext();
  }
  return track;
}

app.post('/api/play', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const track = await queueTrack(query.trim());
    res.json({ queued: track, queue: queue.map((t) => t.title) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to queue track' });
  }
});

app.post('/api/skip', (req, res) => {
  if (!current) {
    return res.status(400).json({ error: 'Nothing is playing' });
  }
  stopCurrent();
  playNext();
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  randomLoopEnabled = false; // otherwise playNext() would immediately refill the queue we just cleared
  queue.length = 0;
  stopCurrent();
  current = null;
  status = 'idle';
  res.json({ ok: true });
});

// Removes a single not-yet-playing track from the queue by its position
// (0 = next up). The currently playing track isn't touched - use /api/skip
// for that.
app.delete('/api/queue/:index', (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
    return res.status(400).json({ error: 'invalid queue index' });
  }
  const [removed] = queue.splice(index, 1);
  res.json({ ok: true, removed, queue: queue.map((t) => t.title) });
});

app.post('/api/volume', (req, res) => {
  const value = Number(req.body.volume);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return res.status(400).json({ error: 'volume must be a number between 0 and 100' });
  }
  volume = Math.round(value);

  if (ffplayProc && ffplayProc.pid) {
    applyLiveVolume(ffplayProc.pid, volume);
  }

  res.json({ ok: true, volume });
});

app.get('/api/state', (req, res) => {
  res.json({
    status,
    current,
    queue: queue.map((t) => t.title),
    volume,
  });
});

// Resolves the cloudflared binary: prefer PATH, fall back to the default
// winget install location (useful right after install, before PATH refreshes
// in an already-open terminal).
function resolveCloudflaredPath() {
  const fallback = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
  return fs.existsSync(fallback) ? fallback : 'cloudflared';
}

function startTunnel(port) {
  const bin = resolveCloudflaredPath();
  const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`]);
  let printed = false;

  const onOutput = (d) => {
    const text = d.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !printed) {
      printed = true;
      console.log(`\n公開URL (誰でもアクセス可): ${match[0]}`);
      if (ACCESS_CODE) {
        console.log(`アクセスコード: ${ACCESS_CODE}\n`);
      } else {
        console.log('注意: ACCESS_CODEが未設定のため、このURLを知る誰でも操作できます。.envで設定を推奨します。\n');
      }
    }
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);

  proc.on('error', (err) => {
    console.error('cloudflaredの起動に失敗しました。インストールされているか確認してください。', err);
  });

  const cleanup = () => proc.kill();
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(); });

  return proc;
}

// Console commands, typed directly into this terminal window:
//   random / r        - queue one random well-known Japanese song
//   random loop / loop - keep auto-queuing random songs forever as the queue empties
//   loop stop          - turn the endless loop back off
function startConsoleCommands() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const cmd = line.trim().toLowerCase();

    if (cmd === 'loop stop' || cmd === 'stoploop' || cmd === 'noloop') {
      randomLoopEnabled = false;
      console.log('ランダムループを停止しました（今流れている曲とキューの残りは最後まで再生されます）。');
      return;
    }

    if (cmd === 'random loop' || cmd === 'loop' || cmd === 'rloop') {
      if (randomLoopEnabled) {
        console.log('ランダムループはすでに有効です。');
        return;
      }
      randomLoopEnabled = true;
      console.log('ランダムループを開始しました（"loop stop" で停止できます）。');
      if (!current) playNext();
      return;
    }

    if (cmd !== 'random' && cmd !== 'r') return;

    const query = pickRandomJapaneseSong();
    console.log(`ランダム再生: 「${query}」を検索しています...`);
    try {
      const track = await queueTrack(query);
      console.log(`キューに追加しました: ${track.title}`);
    } catch (err) {
      console.error('ランダム再生の取得に失敗しました:', err);
    }
  });
}

(async () => {
  await ensureDependencies();

  app.listen(PORT, () => {
    console.log(`YouTube -> Virtual Mic player running at http://localhost:${PORT}`);
    console.log('公開用トンネルを起動しています...');
    startTunnel(PORT);
    console.log('このコンソールで "random" と入力するとランダム再生、"random loop" で無限ループ再生、"loop stop" で停止します。');
    startConsoleCommands();
  });
})();
