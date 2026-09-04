# YouTube → Discord マイク再生アプリ

ブラウザ画面からYouTubeのURLや検索ワードを送信すると、その音声を仮想オーディオケーブル
経由でDiscordの「マイク」として流せるアプリです。

## セットアップ

### 1. VB-Audio Virtual Cable のインストール
1. https://vb-audio.com/Cable/ ページ上部の「VB-CABLE」（無印・無料版）をダウンロードしてインストール
2. PCを再起動（必要な場合あり）

### 2. アプリの起動
```
npm start
```
`ffmpeg`/`yt-dlp`/`cloudflared` が無い場合は自動でインストールされます（初回のみ時間がかかります）。
起動後、`http://localhost:3535` をブラウザで開きます。

### 3. 音声出力先を仮想ケーブルに向ける
1. Windows設定 → システム → サウンド → 「音量ミキサー」を開く
2. 曲を再生した状態で一覧から `ffplay.exe` を探す
3. 出力先を **CABLE Input (VB-Audio Virtual Cable)** に変更

### 4. Discord側のマイクを仮想ケーブルに切り替える
Discordの 設定 → 音声・ビデオ → 入力デバイス を **CABLE Output (VB-Audio Virtual Cable)** に変更します。

自分の声も一緒に聞かせたい場合は、VB-CABLEとは別に「アプリ間ミキサー」（例: Voicemeeter）で
マイク音声と再生音をミックスしてからDiscordに渡す構成にしてください。

## 使い方

- 入力欄にYouTubeのURL、または曲名などの検索ワードを入れて「再生」
- 続けて入力すると再生キューに追加されます
- キューの各曲の「削除」ボタンで、その曲だけをキューから取り除けます
- 「スキップ」で現在の曲を飛ばして次のキューを再生
- 「停止・キュークリア」で再生を止めてキューを空にします
- 音量スライダーで再生音量を即時調整できます

### コンソールコマンド（`npm start` を実行しているウィンドウで入力）
- `random` / `r` — ランダムな曲（日本でよく知られる曲）を1曲再生
- `random loop` / `loop` — キューが空になるたび自動でランダム再生し続ける
- `loop stop` — ループを停止

### 他の人にも操作させたい

`npm start` すると自動でトンネルが立ち上がり、コンソールに以下が表示されます。
```
公開URL (誰でもアクセス可): https://xxxxx.trycloudflare.com
アクセスコード: (.envのACCESS_CODEの値)
```
このURLとアクセスコードを共有すると、他の人もブラウザから曲をキューに追加できます
（再生はあなたのPC上で行われ、あなたのマイクとして流れます）。荒らされた場合は `.env` の
`ACCESS_CODE` を書き換えて再起動してください。URLは `npm start` するたびに変わります。

### exe化して使う
```
npm run build:exe
```
`DiscordMusicPlayer.exe` が生成されます。`.env` を同じフォルダに置いて実行すれば、
Node.jsが無いPCでも `npm start` と同じように使えます。
