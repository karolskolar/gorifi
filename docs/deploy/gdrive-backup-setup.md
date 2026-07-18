# Google Cloud setup for SEC-D2 (encrypted DB backups → Google Drive)

One-time setup **you** do in Google Cloud + Drive. It produces two things the
backup job needs: a **service-account JSON key** and a **Drive folder ID**.
No username/password login on the server — the JSON key is the credential and
Drive access is granted by sharing a folder with the service account's email.

## A. Create a Google Cloud project
1. Go to <https://console.cloud.google.com> (sign in with the Google account that owns the Drive you want backups in).
2. Project dropdown (top bar) → **New Project** → name it e.g. `gorifi-backups` → **Create**, then select it.

## B. Enable the Drive API
3. <https://console.cloud.google.com/apis/library/drive.googleapis.com> → **Enable** (make sure the right project is selected).

## C. Create the service account
4. **IAM & Admin → Service Accounts** → **Create Service Account**.
5. Name it e.g. `gorifi-backup` → **Create and Continue**.
6. **Skip** "Grant this service account access to project" (not needed — Drive access comes from folder sharing) → **Done**.
7. Copy its email — it looks like `gorifi-backup@gorifi-backups.iam.gserviceaccount.com`.

## D. Create the JSON key
8. Click the service account → **Keys** tab → **Add Key → Create new key → JSON → Create**.
9. A `.json` file downloads. **This is a secret** — treat it like a password. Do **not** commit it or paste it into chat.

## E. Create the Drive folder and share it with the service account
10. In <https://drive.google.com> create a folder, e.g. **`Gorifi DB Backups`**.
11. Right-click it → **Share** → paste the service-account email from step 7 → role **Editor** → untick "Notify people" → **Share**.
12. Open the folder; from the URL `https://drive.google.com/drive/folders/XXXXXXXX` copy **`XXXXXXXX`** — that's the **folder ID**.

## F. Hand off to the SEC-D2 session
Provide:
- **The JSON key** — best to place it directly on the server at `/var/www/gorifi/secrets/gdrive-sa.json` (`chmod 600`, owner `gorifi`), or hand it over to place there. Do not paste the key contents into chat/commits.
- **The folder ID** from step 12 (not secret — fine to share in chat).

## Notes
- **Personal Gmail:** a service account has no Drive storage of its own, so backups must land in a folder **you own** and shared with the SA (done above); they count against **your** Drive quota (fine for ~75 MB DB snapshots).
- **rclone** (set up in SEC-D2) will use the `drive` backend with `service_account_file` = the JSON, `scope = drive.file` (the SA can only touch files it creates), and `root_folder_id` = the folder ID.
- Rotation/retention and the WAL-safe snapshot + encryption are handled by the backup script in SEC-D2 — you only provide the key + folder ID.
