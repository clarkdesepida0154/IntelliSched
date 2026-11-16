# IntelliSched: office guide

For the Dean.

## Open IntelliSched
- Double-click **IntelliSched** on the desktop (or Start menu → IntelliSched → **IntelliSched**). The
  page opens in your browser after a few seconds. Clicking it again while it runs only opens the page.
- IntelliSched does **not** run in the background all year: it runs only while you use it.
- Supported browsers (current versions): **Edge, Chrome, Firefox, Brave, Opera**. Internet Explorer
  is not supported.
- PDF files are always made with Edge or Chrome in the background, whichever browser you use. Do not
  remove Edge.

## Closing it
- IntelliSched **closes itself after 60 minutes without use** (Administration → System → Backup
  settings → "Close when unused": 30, 60 or 120 minutes, or never). It makes a backup first if
  anything changed.
- To close it at once: Start menu → IntelliSched → **Stop IntelliSched**. It also backs up first.
- A page left open afterwards says "IntelliSched was closed after a while without use." Open it again
  from the desktop icon.
- If the PC lost power while IntelliSched ran, it notices at the next start and backs up by itself.

## Backups
- IntelliSched backs up when it closes (if anything changed), after each approval, and once a day at
  noon while it runs. Press **Back up now** on Administration → System any time.
- The backups are in `Documents\IntelliSched Backups`. The `.isbak` file is the full backup; the
  `.zip` beside it is a readable copy (Excel files and the printed forms).
- The backup password is the one the Dean set on Administration → System. Without it a backup
  cannot be restored.
- **A second copy:** Administration → System → **Also copy backups to (optional)**: a folder on a USB
  stick, or a Google Drive folder (below). Every backup is then copied there too. If the stick is not
  plugged in, the backup still works, the page says "The second backup folder can't be reached.", and
  the copy is made at the next backup.

## Backups in Google Drive
IntelliSched never uploads anything itself and needs no internet. Google's own **Google Drive for
desktop** app shows the office's Drive as a normal folder and uploads it privately, by itself, whenever
there is internet.
1. Install **Google Drive for desktop** (from Google's website).
2. Sign in with the **office's** Google account.
3. In File Explorer, open the Google Drive (for example `G:\My Drive`) and create a folder
   **IntelliSched Backups**.
4. Paste its path (for example `G:\My Drive\IntelliSched Backups`) into **Also copy backups to** on
   Administration → System, and press **Save settings**.
5. Press **Back up now**, then check on drive.google.com that the new file appears in that folder.

Never share that folder with "Anyone with the link": anyone with the link could take the Dean's data.
Public link folders are not supported.

## If it does not open
1. Restart the PC and sign in to Windows. Double-click the icon again and wait one minute.
2. Still not working: Start menu → **IntelliSched** → **IntelliSched – Check**. It writes a report
   on the Desktop (`IntelliSched-Check_...txt`). It holds no password.
3. Send that report to the team.

## Forgot a password
- An account's password: the Dean can set a new one on Users & Roles (Edit → New password).
- The Dean's own password: the team runs `C:\IntelliSched\scripts\reset-password.ps1` as administrator.
- There is always at least one active Dean account: IntelliSched refuses to lock or demote the last one.

## Who to contact
- The IntelliSched team: ______________________ (name) ______________________ (phone)
- The CCS office's IT contact: ______________________
