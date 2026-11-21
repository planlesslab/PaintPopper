# 🎈 Paint Popper

**Pick. Pump. POP. Repeat!** 30 seconds. One shared canvas. A whole lot of paint chaos.

A party game for phones. Everyone joins a room and gets their own paint colour. When the countdown ends:

1. **Pick** 📍 Tap the canvas to place your paint balloon.
2. **Pump** 🎈 Keep tapping to blow it up. The bigger it gets, the bigger the splash. At max size it bursts by itself, and that splash still counts.
3. **POP** 💥 Hit the big POP button to splash your colour.
4. **Repeat** 🔁 Until the 30 seconds are up.

Newer paint covers older paint, so territory can always be stolen. When the timer hits zero, painting stops, and the player with the most **visible** paint wins.

- **Join by room code, invite link or QR code**
- **One shared canvas** that everyone sees live, including other players' balloons as they pump them
- **Fair scoring**: every phone builds the same splats from the same data, in the same order, so everyone sees the same canvas and the same scores
- **Podium** with each player's % of the canvas and a picture of the final canvas
- **Host handover**: if the host drops out for a minute, the next player takes over
- **No build step**: plain HTML, CSS and JavaScript, hosted free on GitHub Pages with Firebase for live sync

## Try it right now (no setup)

Until you add a Firebase config, the game runs in **local demo mode**: a yellow bar shows at the top, and players sync between tabs on one device.

```bash
cd paint-popper
python3 -m http.server 8000
# open http://localhost:8000 in two or more tabs
```

## Set up Firebase (about 5 minutes, free)

Use a **new Firebase project** for Paint Popper rather than your Bauble Shake one. The database rules are different for each game.

1. Go to <https://console.firebase.google.com> and click **Add project**. You don't need Analytics.
2. Go to **Build → Authentication → Get started → Sign-in method → Anonymous** and click **Enable**.
3. Go to **Build → Realtime Database → Create database**. Pick a region, then choose **Start in locked mode**.
4. Open the database's **Rules** tab. Delete what's there, paste in everything from [`database.rules.json`](database.rules.json), and click **Publish**.
5. Go to **Project settings (⚙) → Your apps** and click the **Web (`</>`)** icon. Register an app (you don't need Firebase Hosting). When it shows the setup code, choose **"Use a `<script>` tag"**. Copy just the values (`apiKey`, `authDomain` and so on) into [`js/firebase-config.js`](js/firebase-config.js), replacing the `YOUR_…` placeholders. Keep the word `export` at the start.
   - Make sure `databaseURL` is filled in. If Firebase didn't give you one, copy the address from the top of the Realtime Database page.
6. Go to **Authentication → Settings → Authorized domains** and add `YOUR-USERNAME.github.io`.

The web config is meant to be public, so committing it is fine. The database rules control who can write what.

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `Paint-Popper`.
2. Upload all the files in this folder, including the hidden `.nojekyll` file. You can drag and drop them onto the repository page, or push with git:
   ```bash
   cd paint-popper
   git init && git add -A && git commit -m "Paint Popper"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/Paint-Popper.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and click **Save**.
4. After a minute or two, the game is live at `https://YOUR-USERNAME.github.io/Paint-Popper/`.

If you use a different repository name, update the Paint Popper link in the nav and the `url` in the `ld+json` block near the top of `index.html`.

## How a game goes

1. The host taps **Create a room** and shares the code, link or QR code.
2. Everyone enters a name and joins. Each player sees their colour in the lobby (Cherry, Blueberry, Sunshine…).
3. The host taps **Start game**. After 3‑2‑1, paint!
4. The podium appears about 1.5 seconds after time runs out. The host can start another round with **Play again**, and everyone stays in the room.

On a computer, click the canvas to place and pump, **Space** to pump and **Enter** to pop.

Up to 12 people can paint at once, one per colour. Anyone beyond that, or anyone who joins mid-round, watches the canvas live and plays next round.

## Troubleshooting

- **The yellow "Local demo mode" bar shows on the live site:** the Firebase config isn't in use yet. Check that `js/firebase-config.js` has your real values (no `YOUR_…` left), then commit and push it.
- **Invite links end in `&local`:** that link was made while the site was in demo mode. Once the config is live, share a fresh link from the lobby.
- **"Couldn't connect to the game server":** check that Anonymous sign-in is enabled (step 2) and your `github.io` domain is authorised (step 6).
- **Players can join but splats don't appear for others:** the rules weren't published, or they're the Bauble Shake rules. Paste `database.rules.json` again and click **Publish**.

## Tuning

| What | Where |
|---|---|
| Round length, countdown, pump speed limit | top of `js/main.js` (`TIME_LIMIT_MS`, `COUNTDOWN_MS`, `PUMP_COOLDOWN_MS`) |
| Max balloon size, splat size, splat shape | `js/paint.js` (`MAX_LEVEL`, `splatRadius`, `splatCircles`) |
| The 12 paint colours and their names | `PALETTE` in `js/paint.js` |
| Page colours, buttons, fonts | `css/style.css` |

Pumping is capped at about 11 pumps a second, so auto-clickers or super-fast tappers get no advantage.

## Project layout

```
index.html               screens (home, lobby, game, results) + Planless Lab header
css/style.css            bright, splashy styling
js/main.js               game flow, rooms, input, rendering
js/paint.js              splat shapes, shared canvas, coverage scoring, balloons, effects
js/backend-firebase.js   Firebase Realtime Database adapter
js/backend-local.js      same API over localStorage for local demo mode
js/firebase-config.js    your Firebase web config
database.rules.json      security rules to paste into Firebase
.nojekyll                tells GitHub Pages to serve the files as they are
```

## Known limitations

- Each splat's time comes from the player's phone, checked against the server clock. A determined cheater could fake splats, so it's built for friendly games, not tournaments.
- Old rooms are never deleted. Each room is small, so the free tier covers a lot of play, but you can clear `rooms` in the Firebase console whenever you like.
