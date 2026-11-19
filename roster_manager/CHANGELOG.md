## 0.5.0
- Optional automatic Authenticator code: store your Microsoft authenticator setup key (encrypted, excluded from backups) and the app generates the verification code itself, so a capture never needs your phone. Also switches a number-match prompt to a verification code when needed. Leave it unset to keep using your phone. Note: this keeps both factors on the server and is likely against employer IT policy.
- Settings → Work logins → "Automatic Authenticator code" with a Check key button.

## 0.4.2
- Event descriptions no longer end with the "Managed by Roster Manager" line.
- Fix: the "Found N items" footer under Sabre's roster table no longer creates an extra all-day "Duty" event on the last day.
- Layover events are a short block (30 min after sign-off, 3 hours) so they don't fill the calendar; the title still shows the real layover length, and the description has sign-off and next report times. "Whole layover" is available in Settings.

## 0.4.1
- Remembers the Microsoft/Sabre sign-in between captures (Virgin has no "Stay signed in"): sign-in cookies are kept encrypted between runs, like a browser that never closes. Authenticator should only be needed when Virgin's own sign-in expires.
- The hidden browser identifies as normal desktop Chrome.

## 0.4.0
- Separate Google calendars per event type, so each can have its own colour (e.g. in Pocket Informant): VA Day Duty, VA Trips (incl. layovers), VA Standby, VA Days Off (days off, blank, annual leave, sick), VA Sim, VA Ground.
- Events already in the old single "VA Roster" calendar are moved into the right calendars on the next sync (no duplicates).
- Sick leave shows as 🤒 Sick Leave.

## 0.3.1
- Handles Microsoft's "Pick an account" screen (chooses your work account, or "Use another account").

## 0.3.0
- Calendar events now follow Roster Buster's layout: one ✈️ event per flight duty (e.g. "✈️ MEL BNE SYD OOL", report → sign off), 💼 Layover (h:mm hours) with the hotel name and phone, 🏠 Day off - DDO / 🏠 Blank day (all day), ⏱️ Standby Duty, 🌴 Annual Leave.
- Duties are classified from Sabre's own Duty Codes table (handles PDO, ALVA, SBY05/07 and future codes); LO rows feed the layover instead of becoming events.
- Settings: home base (MEL), icons on/off, flight events as report→sign off or first departure→last arrival.

## 0.2.0
- Capture now goes all the way: Notice Board (auto-acknowledged only when empty; otherwise shows you the notices first) → Reports → Roster Report → enters the dates → Query → reads every page.
- Roster reader for the Sabre Roster Report: flights, standby, training, days off, blank days, report/sign-off times, overnight sectors, aircraft, position, hotel, remarks.
- Roster cycle built in (28 days from 21 Dec 2026, published 10 days before): the Capture screen defaults to the newest published roster; Home shows the next publication date.

## 0.1.1
- Fix: Microsoft login got stuck after entering the email (ignored Microsoft's hidden off-screen fields).
- Shorter, readable error messages.

## 0.1.0
- First version: on-demand Sabre capture with Microsoft + Sabre login, Authenticator number shown in the panel, remembered sign-in, diagnostics download.
- Review/edit roster, Google Calendar sync (no duplicates, approve removals), Google Drive backups.
- Roster reading for the real Sabre page still to come (needs diagnostics from a first run).
