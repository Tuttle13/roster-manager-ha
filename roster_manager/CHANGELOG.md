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
