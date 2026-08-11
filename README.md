# Movie Night — setup

Same pattern as Glizzy Tracker: a static site on GitHub Pages, backed by a
Google Sheet through Apps Script. The Sheet itself doubles as your history —
every movie night is a row, viewable and searchable right in the Sheet.

## 1. Create the backend (Google Sheet + Apps Script)

1. Go to [sheets.new](https://sheets.new) to create a fresh Google Sheet.
   Name it something like "Movie Night DB".
2. In the Sheet, go to **Extensions > Apps Script**.
3. Delete the placeholder `Code.gs` contents and paste in the `Code.gs`
   from this folder.
4. Click **Deploy > New deployment**.
   - Click the gear icon next to "Select type" and choose **Web app**.
   - Description: anything (e.g. "Movie Night API").
   - Execute as: **Me**.
   - Who has access: **Anyone**.
   - Click **Deploy**, and authorize the script when prompted (you'll see
     an "unverified app" warning — click **Advanced > Go to (project) —
     this is your own script, so it's safe).
5. Copy the **Web app URL** it gives you (ends in `/exec`).

The first time anyone hits the API, it auto-creates two tabs in the Sheet:
`Nights` (one row per movie night, with a JSON blob column for the bracket
state) and `Roster` (everyone who's signed in). You never have to touch the
sheet directly, but you can always open it to browse past movie nights.

## 2. Connect the frontend to it

1. Open `app.js` in this folder.
2. Find this line near the top:
   ```js
   API_URL: "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE",
   ```
3. Replace the placeholder with the Web app URL you copied, e.g.:
   ```js
   API_URL: "https://script.google.com/macros/s/AKfycb.../exec",
   ```

## 3. Host it on GitHub Pages

1. Create a new GitHub repo (e.g. `movie-night`).
2. Push these files to it: `index.html`, `app.js`, `icons.js`,
   `manifest.json`, and the `icons/` folder. (`Code.gs` and this README
   don't need to be published — they can stay out of the repo, or just
   live there for reference.)
3. In the repo, go to **Settings > Pages**, set the source to the branch
   you pushed (usually `main`) and the root folder, then save.
4. GitHub gives you a URL like `https://yourname.github.io/movie-night/`.
   That's the link to share with the group.

## 4. Add it to your home screen

Open the GitHub Pages link on a phone:
- **iOS (Safari)**: Share icon > "Add to Home Screen".
- **Android (Chrome)**: menu (⋮) > "Add to Home screen" / "Install app".

It'll show up with its own icon and open full-screen, like a real app —
no App Store needed.

## Notes

- Anyone with the link can create a movie night, submit films, and vote —
  there's no password, matching how Glizzy Tracker works. Everyone just
  types a display name the first time.
- If you ever need to update the backend logic, edit `Code.gs` in the
  Apps Script editor and use **Deploy > Manage deployments > Edit > New
  version** — editing the code alone doesn't push it live until you
  redeploy.
- The app polls every few seconds while a movie night is open, so votes
  from other people show up without a manual refresh.
