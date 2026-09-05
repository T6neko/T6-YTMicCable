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

// Default grab-bag of songs widely familiar in Japan (J-pop hits, anime
// openings, Vocaloid classics), used to seed songs.txt on first run. Users
// edit songs.txt directly (one YouTube search term per line) to customize
// what the "random" console command picks from.
const DEFAULT_SONG_PICKS = [
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

// songs.txt lives next to the exe (or the project root in dev mode) so it's
// easy to find and edit with a plain text editor - not embedded as a SEA
// asset, since those are read-only.
function getDataDir() {
  return IS_SEA ? path.dirname(process.execPath) : __dirname;
}
const SONGS_FILE = path.join(getDataDir(), 'songs.txt');

function ensureSongsFile() {
  if (fs.existsSync(SONGS_FILE)) return;
  const header =
    '# "random" コマンドがここから曲をランダムに選びます。\n' +
    '# 1行に1曲、YouTubeの検索ワード（曲名やアーティスト名、URLでも可）を書いてください。\n' +
    '# "#" で始まる行と空行は無視されます。保存すればアプリを再起動しなくても反映されます。\n\n';
  fs.writeFileSync(SONGS_FILE, header + DEFAULT_SONG_PICKS.join('\n') + '\n', 'utf8');
}

function loadSongPicks() {
  try {
    const lines = fs.readFileSync(SONGS_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (lines.length > 0) return lines;
  } catch {
    // fall through to defaults below
  }
  return DEFAULT_SONG_PICKS;
}

function pickRandomJapaneseSong() {
  const picks = loadSongPicks();
  return picks[Math.floor(Math.random() * picks.length)];
}

// Search terms deliberately phrased to surface what's currently popular
// ("新曲"/"最新"/ranking wording) rather than a fixed song list, so results
// drift with actual trends over time instead of going stale.
const TRENDING_SEARCH_QUERIES = [
  '邦楽 新曲 2026',
  'JPOP 最新曲',
  '今月の音楽ランキング 邦楽',
  '話題の曲 邦楽',
  'JPOP ヒットチャート',
  'アニソン 新曲 2026',
];

// Pulls a batch of current YouTube search results for a trend-oriented
// query using yt-dlp's flat-playlist mode, which lists titles/ids from the
// search results page directly without a per-video network round trip
// (much faster than resolving each candidate individually).
function fetchTrendingCandidates(query) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveBinary('yt-dlp', 'yt-dlp.exe'), [
      '--no-warnings',
      '--flat-playlist',
      '-J',
      `ytsearch20:${query}`,
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
        const data = JSON.parse(out);
        const entries = (data.entries || [])
          // Trend searches surface a lot of hour-long "medley"/"ranking"
          // compilation videos alongside individual songs; a plausible
          // single-track duration filters those out without needing a
          // second per-video lookup.
          .filter((e) => (
            e && e.id && e.title &&
            !e.is_live && e.live_status !== 'is_live' && e.live_status !== 'is_upcoming' &&
            typeof e.duration === 'number' && e.duration >= 90 && e.duration <= 480
          ))
          .map((e) => ({ title: e.title, url: `https://www.youtube.com/watch?v=${e.id}` }));
        resolve(entries);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Picks the next random/loop track. Most of the time this pulls from a live
// trending search so recent releases show up, not just the fixed songs.txt
// list; it falls back to songs.txt (customizable by the user) on failure or
// the remaining rolls, so both sources stay in the mix.
async function pickPlayableTrack() {
  if (Math.random() < 0.7) {
    try {
      const query = TRENDING_SEARCH_QUERIES[Math.floor(Math.random() * TRENDING_SEARCH_QUERIES.length)];
      const candidates = await fetchTrendingCandidates(query);
      if (candidates.length > 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
      }
    } catch (err) {
      console.error('[ランダム] トレンド検索に失敗、songs.txtから選びます:', err.message || err);
    }
  }
  return resolveTrack(pickRandomJapaneseSong());
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

const VBCABLE_DOWNLOAD_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip';

function isVBCableInstalled() {
  // Testing hook: `FORCE_VBCABLE_INSTALL=1 npm start` makes this always
  // report "not installed" so you can exercise the real download -> extract
  // -> silent-install flow on a machine that already has VB-CABLE, without
  // needing a second PC. Re-running the real installer over an existing
  // install just repairs/reinstalls it - harmless.
  if (process.env.FORCE_VBCABLE_INSTALL === '1') return false;

  const result = spawnSync(resolvePowerShell(), [
    '-NoProfile', '-NonInteractive', '-Command',
    "if (Get-CimInstance Win32_PnPEntity -Filter \"Name like '%VB-Audio Virtual Cable%'\") { 'YES' } else { 'NO' }",
  ], { encoding: 'utf8' });
  return !result.error && result.stdout.trim() === 'YES';
}

// VB-CABLE has no winget package, so it's fetched directly from the
// vendor's site and installed silently. This is not a Windows-signed
// package we control, and installing a kernel audio driver requires admin
// rights - Windows will show a UAC prompt that only the user can approve;
// there is no way to skip that consent step.
async function ensureVBCable() {
  if (isVBCableInstalled()) return;

  console.log('[初回セットアップ] VB-Audio Virtual Cable が見つかりません。インストールします...');
  console.log('[初回セットアップ] 管理者権限の確認ダイアログが表示されたら「はい」を押してください。');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbcable-'));
  const zipPath = path.join(workDir, 'VBCABLE_Driver_Pack.zip');

  try {
    const res = await fetch(VBCABLE_DOWNLOAD_URL);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.error(
      '[初回セットアップ] VB-CABLEのダウンロードに失敗しました。' +
      'https://vb-audio.com/Cable/ から手動でインストールしてください。', err
    );
    return;
  }

  const extractDir = path.join(workDir, 'extracted');
  const unzip = spawnSync(resolvePowerShell(), [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
  ]);
  if (unzip.error || unzip.status !== 0) {
    console.error('[初回セットアップ] VB-CABLEの展開に失敗しました。手動でインストールしてください。');
    return;
  }

  const installerName = os.arch() === 'x64' ? 'VBCABLE_Setup_x64.exe' : 'VBCABLE_Setup.exe';
  const installerPath = path.join(extractDir, installerName);
  if (!fs.existsSync(installerPath)) {
    console.error(`[初回セットアップ] ${installerName} が展開先に見つかりませんでした。手動でインストールしてください。`);
    return;
  }

  // -i -h = silent install. Still requires elevation (kernel driver), hence -Verb RunAs.
  const install = spawnSync(resolvePowerShell(), [
    '-NoProfile', '-NonInteractive', '-Command',
    `Start-Process -FilePath '${installerPath}' -ArgumentList '-i','-h' -Verb RunAs -Wait`,
  ]);

  if (install.error || install.status !== 0) {
    console.error(
      '[初回セットアップ] VB-CABLEのインストールに失敗しました' +
      '（管理者権限の確認でキャンセルした場合もここに来ます）。' +
      `手動でインストールしてください: ${installerPath}`
    );
    return;
  }

  console.log('[初回セットアップ] VB-CABLEをインストールしました。反映されない場合はPCの再起動をお試しください。');
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
    const searching = !isUrl(query);
    const input = searching ? `ytsearch1:${query}` : query;
    const args = ['--no-warnings', '--no-playlist'];
    // For a search, --flat-playlist skips fully resolving the video (skips
    // fetching formats/subtitles/etc.) and just reads it off the search
    // results page - ~3x faster (search+resolve drops from ~20s to ~6s in
    // testing) since we only need id/title here; full resolution still
    // happens once for real at actual playback time in playNext(). This
    // doesn't help for a direct video URL (not a search), which always
    // needs the full fetch regardless.
    if (searching) args.push('--flat-playlist');
    args.push('-j', input);

    const proc = spawn(resolveBinary('yt-dlp', 'yt-dlp.exe'), args);

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
        const url = info.webpage_url || info.url || `https://www.youtube.com/watch?v=${info.id}`;
        resolve({ title: info.title, url });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function playNext() {
  if (queue.length === 0 && randomLoopEnabled) {
    console.log('[ランダムループ] 次の曲を探しています...');
    try {
      const track = await pickPlayableTrack();
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
    // ffplay closing doesn't mean the paired yt-dlp download has finished -
    // for a live stream in particular it can otherwise keep running forever,
    // orphaned, as a hidden background process.
    if (ytdlpProc) {
      ytdlpProc.kill('SIGKILL');
    }
    ytdlpProc = null;
    ffplayProc = null;
    playNext();
  };

  ytdlpProc.on('close', () => {
    if (generation === playGeneration) ytdlpProc = null;
  });
  ffplayProc.on('close', advance);
}

function enqueueTrack(track) {
  queue.push(track);
  if (!current) {
    playNext();
  }
  return track;
}

async function queueTrack(query) {
  const track = await resolveTrack(query);
  return enqueueTrack(track);
}

// Shared logic behind both the HTTP API and the console commands below, so
// "everything the web UI can do" stays in one place instead of two.

function doSkip() {
  if (!current) return { error: 'Nothing is playing' };
  stopCurrent();
  playNext();
  return { ok: true };
}

function doStop() {
  randomLoopEnabled = false; // otherwise playNext() would immediately refill the queue we just cleared
  queue.length = 0;
  stopCurrent();
  current = null;
  status = 'idle';
  return { ok: true };
}

// Removes a single not-yet-playing track from the queue by its position
// (0 = next up). The currently playing track isn't touched - use doSkip()
// for that.
function doRemoveFromQueue(index) {
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
    return { error: 'invalid queue index' };
  }
  const [removed] = queue.splice(index, 1);
  return { ok: true, removed, queue: queue.map((t) => t.title) };
}

function doSetVolume(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return { error: 'volume must be a number between 0 and 100' };
  }
  volume = Math.round(value);
  if (ffplayProc && ffplayProc.pid) {
    applyLiveVolume(ffplayProc.pid, volume);
  }
  return { ok: true, volume };
}

function getStateSnapshot() {
  return { status, current, queue: queue.map((t) => t.title), volume };
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
  const result = doSkip();
  res.status(result.error ? 400 : 200).json(result);
});

app.post('/api/stop', (req, res) => {
  res.json(doStop());
});

app.delete('/api/queue/:index', (req, res) => {
  const result = doRemoveFromQueue(Number(req.params.index));
  res.status(result.error ? 400 : 200).json(result);
});

app.post('/api/volume', (req, res) => {
  const result = doSetVolume(Number(req.body.volume));
  res.status(result.error ? 400 : 200).json(result);
});

app.get('/api/state', (req, res) => {
  res.json(getStateSnapshot());
});

// Resolves the cloudflared binary: prefer PATH, fall back to the default
// winget install location (useful right after install, before PATH refreshes
// in an already-open terminal).
function resolveCloudflaredPath() {
  const fallback = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
  return fs.existsSync(fallback) ? fallback : 'cloudflared';
}

let tunnelProc = null;

function startTunnel(port) {
  const bin = resolveCloudflaredPath();
  const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`]);
  tunnelProc = proc;
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

  return proc;
}

const CONSOLE_HELP = `使えるコマンド:
  play <URLまたは検索ワード> / p <...>  - 曲をキューに追加
  skip / s                              - 今の曲をスキップ
  stop                                  - 停止してキューを空にする
  queue / q                             - 状態とキューを表示
  remove <番号> / rm <番号>             - キューからその曲だけ削除（queueで表示される番号）
  volume <0-100> / v <0-100>            - 音量を変更
  random / r                            - ランダムな曲を1曲追加
  random loop / loop                    - キューが空になるたび自動でランダム再生
  loop stop                             - ランダムループを停止
  help / ?                              - このヘルプを表示`;

// Console commands, typed directly into this terminal window - mirrors
// everything the web UI (http://localhost:PORT) can do, for when it's more
// convenient to just type into this window instead.
function startConsoleCommands() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const spaceIndex = line.indexOf(' ');
    const cmd = (spaceIndex === -1 ? line : line.slice(0, spaceIndex)).toLowerCase();
    const arg = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1).trim();
    const lowerLine = line.toLowerCase();

    if (cmd === 'help' || cmd === '?') {
      console.log(CONSOLE_HELP);
      return;
    }

    if (lowerLine === 'loop stop' || cmd === 'stoploop' || cmd === 'noloop') {
      randomLoopEnabled = false;
      console.log('ランダムループを停止しました（今流れている曲とキューの残りは最後まで再生されます）。');
      return;
    }

    if (lowerLine === 'random loop' || cmd === 'loop' || cmd === 'rloop') {
      if (randomLoopEnabled) {
        console.log('ランダムループはすでに有効です。');
        return;
      }
      randomLoopEnabled = true;
      console.log('ランダムループを開始しました（"loop stop" で停止できます）。');
      if (!current) playNext();
      return;
    }

    if (cmd === 'random' || cmd === 'r') {
      console.log('ランダム再生: 曲を探しています...');
      try {
        const track = await pickPlayableTrack();
        enqueueTrack(track);
        console.log(`キューに追加しました: ${track.title}`);
      } catch (err) {
        console.error('ランダム再生の取得に失敗しました:', err);
      }
      return;
    }

    if (cmd === 'play' || cmd === 'p') {
      if (!arg) {
        console.log('使い方: play <URLまたは検索ワード>');
        return;
      }
      try {
        const track = await queueTrack(arg);
        console.log(`キューに追加しました: ${track.title}`);
      } catch (err) {
        console.error('曲の取得に失敗しました:', err.message || err);
      }
      return;
    }

    if (cmd === 'skip' || cmd === 's') {
      const result = doSkip();
      console.log(result.error || 'スキップしました。');
      return;
    }

    if (cmd === 'stop') {
      doStop();
      console.log('停止し、キューを空にしました。');
      return;
    }

    if (cmd === 'queue' || cmd === 'q' || cmd === 'list') {
      const s = getStateSnapshot();
      console.log(`状態: ${s.status}`);
      console.log(`再生中: ${s.current ? s.current.title : '(なし)'}`);
      console.log(`音量: ${s.volume}%`);
      if (s.queue.length === 0) {
        console.log('キュー: (空)');
      } else {
        console.log('キュー:');
        s.queue.forEach((title, i) => console.log(`  [${i}] ${title}`));
      }
      return;
    }

    if (cmd === 'remove' || cmd === 'rm' || cmd === 'del') {
      const result = doRemoveFromQueue(Number(arg));
      console.log(result.error ? result.error : `削除しました: ${result.removed.title}`);
      return;
    }

    if (cmd === 'volume' || cmd === 'v') {
      const result = doSetVolume(Number(arg));
      console.log(result.error ? result.error : `音量を${result.volume}%にしました。`);
      return;
    }

    console.log(`不明なコマンドです: "${cmd}"（"help" で使えるコマンド一覧を表示）`);
  });
}

// Without this, closing the app (window X, Ctrl+C, task kill) leaves the
// currently playing track's yt-dlp/ffplay pair and the cloudflared tunnel
// running forever in the background as orphaned processes - for a live
// stream in particular, that means it silently keeps "playing" long after
// the app appears to be gone.
let cleanedUp = false;
function cleanupAndExit() {
  if (cleanedUp) return;
  cleanedUp = true;
  stopCurrent();
  if (tunnelProc) tunnelProc.kill('SIGKILL');
}
process.on('exit', cleanupAndExit);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => { cleanupAndExit(); process.exit(); });
}

(async () => {
  ensureSongsFile();
  await ensureDependencies();
  await ensureVBCable();

  app.listen(PORT, () => {
    console.log(`YouTube -> Virtual Mic player running at http://localhost:${PORT}`);
    console.log('公開用トンネルを起動しています...');
    startTunnel(PORT);
    console.log(`ランダム再生の曲リストは ${SONGS_FILE} を編集するとカスタマイズできます。`);
    console.log('このコンソールでも操作できます。"help" と入力するとコマンド一覧を表示します。');
    startConsoleCommands();
  });
})();
