# Roster Manager

Opens **Roster** in the Home Assistant sidebar. Press **Capture Roster** and the app logs into Sabre (via Microsoft), reads your roster, lets you review it, then syncs it to Google Calendar and backs it up to Google Drive.

## First-time setup
1. **Settings → Work logins**: check the email and Sabre User ID, enter both passwords, **Save**, then **Test login**. If Microsoft asks, the panel shows the number to enter in Authenticator.
2. **Settings → Google account**: enter the OAuth Client ID and Client secret, **Save**, then **Connect Google**. Do this from a computer browser at your Home Assistant address, because Google sign-in won't open inside the Home Assistant app.

## Privacy and safety
- Sabre is contacted only when you press Capture or Test. There's no polling, scheduling or automatic retries, and each run is limited to 5 minutes.
- Passwords and the Google token are encrypted in the app's private storage. They're never shown again or logged, and are excluded from Home Assistant backups and Google Drive backups.
- The app can only reach the Google calendar and Drive files it created itself.
- Diagnostics (screenshots and page layout, no passwords or form values) are kept for the last 6 runs, and can be downloaded from the panel.

## Automatic capture (optional)
Settings → **Automatic capture**. With it on, the app fetches each newly published roster on its Friday and adds it to your calendar with no taps: first attempt at a random time in the chosen hour, retrying every 20 minutes if Sabre is down (pausing overnight), giving up after a few days. It only adds and updates events — it never deletes. Needs the work passwords saved, Google connected, and the authenticator key set for a no-phone run. Set a **phone notification service** (your Home Assistant mobile app notify service, without the `notify.` prefix) to be told when the roster lands or if it needs you.
