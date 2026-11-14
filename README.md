# Move Scanner Autopilot (data collector)

Runs by itself on GitHub every 15 minutes. No server, no API keys, no browser needed, nothing to press.
It scans Binance public data with the stress-tested engine (magnitude + direction models), logs
**every signal with its full feature vector** to this repo, and later writes down what actually happened.
The web page (GitHub Pages) shows the live signals and how the models are holding up.

The whole point is the data: after a few weeks you download it and it becomes the training set for
the next, better model. It is also the live referee for the paper bot (its own repo): the
"Live calibration" tab tracks the exact numbers the bot's entry filter depends on — the lean
strength buckets and the flagged event rate — on data the models never saw. Paper only — this never
places orders.

## Set up (about 5 minutes, once)

1. On github.com click **New repository**. Name it e.g. `move-scanner-autopilot`, choose **Public**, click Create.
   (Public matters: scheduled jobs are free and unlimited on public repos.)
2. Click **uploading an existing file** and drag in everything from this folder
   (`.github`, `docs`, `scanner`, `config.json`, `README.md`), then **Commit changes**.
   - If the hidden `.github` folder does not upload: click **Add file > Create new file**, type
     `.github/workflows/scan.yml` as the name and paste the content of that file from this folder.
3. **Settings > Pages**: Source = *Deploy from a branch*, Branch = `main`, folder = `/docs`, Save.
   Your page address appears there after a minute or two.
4. **Actions** tab: if GitHub asks, click *I understand my workflows, enable them*. Open
   **Scanner autopilot** and click **Run workflow** once — the first run takes 2–4 minutes.
5. Open your Pages address. Bookmark it. That's all: it updates itself.

## What it collects (the "every detail" list)

Per closed candle (15m and 1h), for every scanned coin:

- the 11 magnitude-model features and the 5 direction-model inputs,
- model probabilities (any / up / down) for all 6 look-ahead windows,
- the event sizes for all 6 windows and the top-5% flag,
- the calibrated direction lean per window,
- and 6 candles later: which side touched first, after how many candles, the max move up
  and down (MFE/MAE), and the close.

Files in `docs/data/`: `signals-<date>.jsonl`, `outcomes-<date>.jsonl`, `scans-<date>.jsonl`,
plus `state.json` (dashboard snapshot) and `stats.json` (live calibration counters).
Files older than `retentionDays` (default 120) are deleted automatically.

## Settings

Edit `config.json` on GitHub (pencil icon):
`topN` (coins scanned, default 40), `minVolUsd` (volume floor, default 1000000),
`retentionDays` (default 120). The next scan picks it up. `startMs` is set automatically on the
first run — delete that line to restart collection from today.

## Things to know

- GitHub pauses scheduled jobs after 60 days with no human activity in the repo. If the page says
  data is old, open the Actions tab and re-enable the workflow.
- At default settings the repo grows by roughly 1–3 MB per day. Download the data regularly
  (see the Data tab on the page) and lower `topN` or `retentionDays` if that is too much for you.
- The engine is the exact code from the scanner that was stress-tested on 2022–2026 data
  (calibration reproduced bit-for-bit). Live numbers will drift from the offline validation as
  the market changes — that drift is exactly what this repo measures.
- Judge the live calibration stats after ~1,000 resolved signals at 1h (about two weeks), not sooner.

## Bringing the data back (the improvement loop)

1. Let it run 3–4 weeks minimum.
2. **Code → Download ZIP** on your repo, or grab `docs/data/*.jsonl` from the page's Data tab.
3. Give the zip to your analyst. Retraining uses the same feature schema, so the files plug
   straight into the existing pipeline.

Research tool. No orders, no API keys, no financial advice.
