# X Followers Cleaner

Chrome extension (Manifest V3) to **analyze, score, filter, and clean** low-quality or spam followers on **X (Twitter)**.

Works with your logged-in session: it intercepts X’s own GraphQL responses while you browse your Followers list (no official API keys required).

## Features

- **Collect followers** from `/followers`, `/verified_followers`, and also following lists
- **Auto-scan / auto-scroll** so X loads more pages of the list
- **Quality & spam risk score** (0–100) based on:
  - account age
  - default avatar / empty bio
  - zero or very few posts
  - extreme following/followers ratios (follow-farm)
  - spam patterns in handle / name / bio
  - verified / mutual signals
- **Dashboard popup**: search, category filters, min risk slider, sort, pagination
- **Export** full dataset to **JSON** or **CSV**
- **Bulk “Remove this follower”** (DOM automation on the open Followers page, rate-limited)
- Floating panel on x.com with live counters

## Install (Developer mode)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension` folder in this repo.
4. Pin **X Followers Cleaner** to the toolbar

## How to use

1. Log in to [x.com](https://x.com)
2. Open your profile → **Followers**
   Example: `https://x.com/YOUR_HANDLE/followers`
3. Click the extension icon → **Start scan**, or use the floating panel on the page
4. Leave the Followers tab visible while it auto-scrolls
5. Open the **full dashboard** (full browser tab):
   - Click the extension toolbar icon
   - Floating panel → **Open dashboard**
   - Or right‑click the extension → **Options**
6. Filter by risk, “no posts”, default avatar, etc.; export or bulk remove

### Tips

- Prefer cleaning in small batches to avoid temporary rate limits
- For removal, keep the Followers list scrolled so the target UserCell is still in the DOM
- If the popup says the content script is not ready, **reload** the X tab once after installing

## Architecture

```
extension/
  manifest.json
  background/service-worker.js   # badge + downloads + open dashboard tab
  content/
    interceptor.js               # MAIN world: fetch/XHR GraphQL capture
    content.js                   # ISOLATED: panel, storage, scroll, remove queue
    styles.css
  lib/
    constants.js
    scoring.js                   # normalize + risk algorithms
  popup/
    popup.html / popup.css / app.js   # compact popup
  dashboard/
    dashboard.html / dashboard.css    # full-screen tab UI
  icons/
```

1. **interceptor.js** (MAIN world) patches `fetch` and `XMLHttpRequest`, posts follower GraphQL JSON to the page.
2. **content.js** normalizes users, scores them, stores in `chrome.storage.local`, exposes messages to the popup.
3. **popup** filters/sorts the local corpus and triggers scan/export/remove.

## Risk score (how it works)

Each follower starts at **0**. Rules **add or subtract points**. Final **risk = clamp(sum, 0–100)**.
**Quality = 100 − risk**.

| Band     | Range  | Meaning                         |
| -------- | ------ | ------------------------------- |
| Low      | 0–34   | Looks normal                    |
| Medium   | 35–54  | Weak signals — review           |
| High     | 55–74  | Strong spam / inactive patterns |
| Critical | 75–100 | Likely bot / shell / spam       |

### Main drivers (+)

- Very new / new / young account
- Default avatar, empty / thin bio, empty shell profile
- 0 / few posts, ghost (old + silent), follow-farm
- Extreme following:followers ratio, mass following
- Spam bio / handle / display name patterns

### Offsets (−)

- Verified / Premium
- Mutual follow
- Listed on public lists
- Established + active poster, healthy ratio

In the **full dashboard**:

- Sidebar → **How scores work** — full rule table with points
- Click any **risk number** — per-user breakdown (each rule ± points)

After upgrading, click **Re-score all** so older stored rows get the new algorithm + breakdown.

Categories: `ok`, `inactive`, `medium`, `high_risk`, `critical`.

## Privacy & Security

- All follower data and analysis stay **local** in the browser (`chrome.storage.local`).
- The extension runs entirely on `x.com` / `twitter.com` and does not send data to external servers.
- Tokens required by X’s internal API are read from your active browser session, used only in-memory, and are never logged, stored, or transmitted anywhere.
- No hardcoded API keys, secrets, or access tokens are included.

## Limitations

- X rotates internal GraphQL query IDs and may change payloads; capture is pattern-based on URL paths (`/Followers`, etc.)
- Official “remove follower” is not a public stable API for third parties — removal is best-effort via UI menus
- Do not automate aggressive mass removals; respect X’s terms and rate limits
- Large accounts: full list collection may take time (scroll + pagination)

## Development

No build step. Edit files under `extension/` and click **Reload** on `chrome://extensions`.

Optional local test of scoring:

```bash
node -e "const s=require('./extension/lib/scoring.js'); console.log(s.scoreFollower({screenName:'user12345678',followersCount:0,followingCount:900,statusesCount:0,defaultProfileImage:true,description:''}))"
```

## Disclaimer

For personal account hygiene. You are responsible for how you use bulk remove/block actions and for compliance with X’s Terms of Service.

## License

Released under the [MIT License](LICENSE).
