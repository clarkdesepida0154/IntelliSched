# IntelliSched install day checklist (for the team)

The office PC goes live on Monday 16 or Tuesday 17 Nov 2026. Each block has a 30-minute time box. If
a block runs over, stop and use the rollback at the end.

## Before install day (on the team laptop with the repo)

- [ ] The **Office kit** is ready: `.deploy-out\IntelliSched-Office-Kit-1.0.1-<commit>\` (it holds
  `data\handover.isbak` and `data\handover-training.enc`, made from the real data on 14 Nov 2026).
- [ ] **Only if the real data changed since then**: double-click `deploy\MAKE-HANDOVER.bat`. Type your
  own handover password twice (8 or more characters, not `intellisched`) and say whether to keep the
  Dean's starting password. It backs up the real data (read only), keeps exactly one account (the
  Dean), and puts new handover files into the newest Office kit and a new `OFFICE-PASSWORDS.txt`.
- [ ] Print `.deploy-out\OFFICE-PASSWORDS.txt` (the handover password, the Dean's sign-in email and
  starting password). Keep the paper **apart from the USB sticks**.
- [ ] Copy the **Office kit** folder to **two** USB sticks. The Practice kit never goes to the office;
  the Office kit never goes onto a borrowed laptop.
- [ ] Bring both sticks, the paper, this checklist and a phone for photos of any error.

## At the office

### 1. Check the PC (30 min)
- [ ] Copy the Office kit folder from the USB stick to the PC (for example `C:\Kit`, not the Desktop).
- [ ] Double-click `CHECK.bat`. Every line PASS or WARN; read the WARN lines (for example "Under 4 GB
  RAM: close other programs while generating").
- [ ] A FAIL: fix it (free disk space, restart for a pending update) and run `CHECK.bat` again.

### 2. Install (30 min)
- [ ] Right-click `INSTALL.bat` -> **Run as administrator**.
- [ ] Type the **handover password** from the paper.
- [ ] "IntelliSched will run for ...": press Enter if the name is the office's daily Windows account.
- [ ] Wait for **INSTALL: PASS** and the self-test lines (all PASS, including "Retrain data
  present"). The browser opens.

### 3. The Dean signs in (30 min)
- [ ] Sign in with the Dean's email and the **starting password** from the paper.
- [ ] IntelliSched shows **Change your starting password**: the Dean types the starting password and
  a new one twice (8 or more characters). Nothing else opens before this.
- [ ] Users & Roles: the Dean may edit his name, email and title (and his password).
- [ ] **Administration -> System -> change the backup password.** Write it down and keep it safe.
- [ ] Optional, **Google Drive**: install Google Drive for desktop, sign in with the office's account,
  create `My Drive\IntelliSched Backups`, paste its path into **Also copy backups to** (Administration
  -> System -> Backup settings), Save, **Back up now**, and check the file on drive.google.com. Never
  share that folder with "Anyone with the link".

### 4. Acceptance tests with Wi-Fi OFF (30 min)
Turn Wi-Fi off (and unplug the network cable) first.
- [ ] Sign in. Open the term (2nd Semester AY 2026-2027) and the approved version.
- [ ] Print Outputs: one **Teachers' Program**, one **Class Schedule** and the **Room Schedule**, each as
  **PDF** and as **Word**. Open each file.
- [ ] Administration -> System -> **Back up now**. Both files appear in `Documents\IntelliSched Backups`
  (and in the second folder when one is set).
- [ ] Start menu -> IntelliSched -> **Stop IntelliSched**. A message says it is closed.
- [ ] **Restart the PC.** Sign in to Windows. IntelliSched is NOT running by itself (correct).
- [ ] Double-click the **IntelliSched** desktop icon. The page opens. Sign in again.

### 5. The first backup to a USB stick (30 min)
- [ ] Copy the newest `IntelliSched-backup_....isbak` from `Documents\IntelliSched Backups` to a USB
  stick, or set the stick's folder as **Also copy backups to**.
- [ ] Turn Wi-Fi back on if the office uses it.

### 6. Show the Dean the routine (30 min)
- [ ] Open IntelliSched from the desktop icon; a second click only opens the page again.
- [ ] **IntelliSched closes itself after 60 minutes without use** (backing up first if anything
  changed). A page left open then says so; open it again from the icon.
- [ ] **Stop IntelliSched** (Start menu) closes it at once, with the same backup.
- [ ] If it does not open: restart the PC, then Start menu -> IntelliSched -> **IntelliSched – Check**,
  and send the report on the Desktop.
- [ ] Leave `OFFICE-GUIDE.md` printed beside the PC.
- [ ] **Shred the OFFICE-PASSWORDS.txt paper** once the Dean has his own password and the backup
  password is changed.

## Rollback (if the install fails)

- Right-click `UNINSTALL.bat` -> Run as administrator -> type `REMOVE` (press Enter at the second
  question to keep the backups).
- The office keeps working by hand that day. Nothing on the PC outside `C:\IntelliSched` was changed
  (apart from the Visual C++ runtime, a Microsoft component other programs share, which stays).
- Run `CHECK.bat`, take the report and the install log home, and fix it with the team.
