INTELLISCHED - READ THIS FIRST
==============================

This folder is an IntelliSched installation kit. It installs everything IntelliSched needs on one
Windows PC. Nothing is downloaded; the PC does not need the internet.
Everything goes into C:\IntelliSched. Nothing else on the PC is changed.

TWO KITS
--------
Practice kit   (IntelliSched-Kit-<version>)         practice data only (data\practice.isbak).
               The ONLY kit for borrowed laptops.
Office kit     (IntelliSched-Office-Kit-<version>)  the Dean's real data (data\handover.isbak and
               data\handover-training.enc), encrypted with the handover password on the
               OFFICE-PASSWORDS.txt paper. Only for the office PC. Keep the paper apart from the
               USB sticks.

WHAT THE PC NEEDS
-----------------
- Windows 10 (version 1809 or newer) or Windows 11, 64-bit.
  Windows 8 and 8.1 cannot run IntelliSched (MongoDB 7, Node 24 and current Edge do not run on them).
- 4 GB of memory recommended (2 GB minimum; under 4 GB, close other programs while generating).
- 3 GB free on drive C:.
- An administrator account for installing, updating and uninstalling.
- Microsoft Edge or Google Chrome (for the PDF files).

THE FILES YOU USE
-----------------
INSTALL.bat     Installs IntelliSched. Right-click it and choose "Run as administrator".
                Practice kit: 1 = Practice or 2 = Office, then the backup's password.
                Office kit: the handover password (from OFFICE-PASSWORDS.txt); nothing else to choose.
UPDATE.bat      Installs a newer version over an installed one. Your data and settings stay.
                A full backup is made first; if anything fails, the old version comes back.
                Right-click it and choose "Run as administrator".
UNINSTALL.bat   Removes IntelliSched from this PC. Right-click, "Run as administrator",
                then type REMOVE. The backups in Documents are kept unless you also type
                DELETE BACKUPS.
CHECK.bat       Checks the PC and the installed system, and writes a report to the Desktop
                (IntelliSched-Check_<computer>_<date>.txt). It holds no password.

AFTER THE INSTALL
-----------------
Open IntelliSched from the desktop icon "IntelliSched" (or the Start menu). It does not run in the
background: it runs only while it is used, and closes itself after 60 minutes without use, making a
backup first if anything changed. Start menu -> IntelliSched -> "Stop IntelliSched" closes it at once.
Office: sign in as the Dean with the starting password from OFFICE-PASSWORDS.txt, choose a new
password, then open Administration -> System and change the backup password.

IF SOMETHING FAILS
------------------
Every script ends with PASS or FAIL and the path of its log.
1. Run CHECK.bat.
2. Send the report from the Desktop (IntelliSched-Check_...txt) to the team.
If an antivirus blocked a file, the message names it: allow C:\IntelliSched in the antivirus,
then run INSTALL.bat again.

OTHER FILES
-----------
INSTALL-DAY-CHECKLIST.md   the team's plan for the install day
OFFICE-GUIDE.md            one page for the Dean
payload.zip                the program files (do not open)
kit-manifest.json          versions and checksums of everything in the kit
scripts\, data\            used by the .bat files
