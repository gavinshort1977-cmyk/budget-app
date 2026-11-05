# Monthly Budget: setup guide

This guide is for people who don't write code. Do the parts in order. Part 1 is all the app needs to work. Parts 2 and 3 are only needed for Google Drive sync between devices.

- **Part 1:** Put the app online for free with GitHub Pages (about 5 minutes)
- **Part 2:** Create a Google client ID for your wife's Gmail sync (about 15 minutes)
- **Part 3:** Install the app on her phone, tablet and computer
- **Part 4:** Day-to-day tips, backups and troubleshooting

> **Privacy:** The repository holds only the app's code. No budget figures go into it. Her figures stay in her browser on each device and, if sync is on, in a file in her own Google Drive.

---

## Part 1: Publish the app on GitHub Pages

The app will live at:

**`https://gavinshort1977-cmyk.github.io/budget-app/`**

Your expense tracker stays at `https://gavinshort1977-cmyk.github.io/expense-tracker/`. The two apps share a web address, but each one keeps its storage separate.

The app's files are already in your **`budget-app`** repository on GitHub. All you need to do is switch on GitHub Pages:

1. Go to <https://github.com/gavinshort1977-cmyk/budget-app> and sign in.
2. Click **Settings**, then click **Pages** in the left menu.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Under **Branch**, choose **main**, then **/docs** (not `/root`), and click **Save**.
5. Wait 1–3 minutes, then refresh the page. A box appears that says *"Your site is live at …"*.
6. Open `https://gavinshort1977-cmyk.github.io/budget-app/`. The budget should appear.

> Free GitHub Pages needs the repository to be **Public**. If Pages asks you to upgrade, go to **Settings**, then **General**, then **Danger Zone**, then **Change visibility**, and choose **Public**. This is safe because the repository holds only code, never budget figures.

At this point the app fully works on one device, without sync. Settings shows *"Sync is off"*. That's expected until you finish Part 2.

---

## Part 2: Set up the Google client ID for your wife's Gmail

### Can I reuse my existing Google Cloud client ID?

**Technically yes, but I recommend a new one.**

- **Why it would work:** Google allows sign-in from a *web origin*, which is `https://gavinshort1977-cmyk.github.io` with no folder. Your expense tracker already uses that origin, so your existing client ID would accept sign-ins from this app too.
- **Why a new one is better:**
  - The Google sign-in screen shows the **project's app name**. With a new project she sees "Monthly Budget", not your expense tracker's name.
  - With the `drive.file` permission, Google lets every app that uses the same client ID see the files that client created. With separate client IDs, neither app can ever see the other's Drive files, even by accident.
  - You can manage her test-user access, or revoke it, without affecting your own app.

### Must her Gmail be added as a test user?

**Yes, as long as the app stays in "Testing" mode, which is the simplest setup.** While the app is in Testing, Google blocks anyone who isn't on the test-user list and shows *"Access blocked"*. Add her Gmail address, and add yours too if you want to try sync yourself. You can list up to 100 test users.

You could also click **Publish app** to switch to "In production". The `drive.file` permission is classed by Google as *non-sensitive*, so publishing doesn't need Google's full review. She might then see a "Google hasn't verified this app" screen. For one family member, Testing plus a test user is the easier option.

### 2.1 Create the project and client ID

You can do all of this signed in as **you**. The Google Cloud project doesn't need to belong to her. She only uses her Gmail to sign in to the app.

1. Go to <https://console.cloud.google.com/>.
2. Click the project picker at the top, then **New project**. Name it `Monthly Budget` and click **Create**. Then make sure **Monthly Budget** is the project selected at the top.
3. **Turn on the Drive API:** open the menu (☰), then **APIs & Services**, then **Library**. Search for **Google Drive API**, open it and click **Enable**.
4. **Set up the sign-in screen:** open the menu (☰), then **Google Auth Platform**. In older layouts this is under **APIs & Services**, then **OAuth consent screen**. Click **Get started**.
   - **App name:** `Monthly Budget`
   - **User support email:** your email
   - **Audience:** **External**
   - **Contact information:** your email
   - Tick the agreement box and click **Create**.
5. **Add her as a test user:** in Google Auth Platform, go to **Audience**, then **Test users**, then **Add users**. Enter **her Gmail address** and click **Save**.
6. **Optional:** go to **Data Access**, then **Add or remove scopes**. Tick `.../auth/drive.file` ("See, edit, create and delete only the specific Google Drive files you use with this app"), then click **Update** and **Save**.
7. **Create the client ID:** go to **Clients**, then **Create client**.
   - **Application type:** **Web application**
   - **Name:** `Monthly Budget web`
   - **Authorized JavaScript origins:** click **Add URI** and enter exactly `https://gavinshort1977-cmyk.github.io`. Don't add a folder, and don't add a slash at the end.
   - **Authorized redirect URIs:** leave this empty.
   - Click **Create**.
8. Copy the **Client ID**. It ends in `.apps.googleusercontent.com`.
   - **Don't** copy, download or use the client secret. The app never needs it, and it must never be put into the app.

### 2.2 Put the client ID into the app

1. On GitHub, open your `budget-app` repository. Go to the `docs` folder, then `js`, then open `config.js`.
2. Click the **pencil** icon (Edit this file).
3. Find this line:
   ```js
   export const GOOGLE_CLIENT_ID = '';
   ```
   Paste the client ID between the two quote marks, like this:
   ```js
   export const GOOGLE_CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
   ```
4. Click **Commit changes**, then **Commit changes** again.
5. Wait about 2 minutes, then reload the app. **Settings** now shows **Sign in with Google**. Devices that already have the app pick up the change the next time they open it while online.

---

## Part 3: Install the app on her devices

Do the following on each device. **Install the app first, then sign in from inside the installed app.** The installed app keeps its own storage, separate from the browser.

### Android (Chrome)
1. Open `https://gavinshort1977-cmyk.github.io/budget-app/` in **Chrome**.
2. Tap the **⋮** menu, then **Install app**. On some phones this is called **Add to Home screen**, then **Install**.
3. Open **Budget** from the home screen.

### iPhone or iPad (Safari)
1. Open the address in **Safari**. Other browsers on iPhone may not offer installing.
2. Tap the **Share** button (the square with an arrow pointing up), then **Add to Home Screen**, then **Add**.
3. Open **Budget** from the home screen.

### Windows or Mac computer (Chrome or Edge)
1. Open the address.
2. Click the **install** icon at the right end of the address bar. Or use the **⋮** menu, then **Cast, save and share**, then **Install page as app**. In Edge, use **…**, then **Apps**, then **Install this site as an app**.

### Turn on sync (on each device)
1. In the app, open **Settings** and tap **Sign in with Google**.
2. The Google account picker appears every time. Choose **her Gmail**.
3. If Google warns that the app is unverified or in testing, tap **Continue**.
4. Allow access to *"the specific Google Drive files you use with this app"*.
5. Settings now shows **Signed in as** her address, and her address also appears under the app title. The first device creates the file **"Monthly Budget App Data"** in her Drive, and other devices then sync with it.

**If a device already has figures on it** and her Drive already has a budget, the app asks whether to **combine both** or **use the Drive data only**. It never decides for her.

### Optional: encrypt the Drive file
Go to **Settings**, then **Set a passphrase…**. Every device asks for the passphrase once.

> ⚠️ **If the passphrase is lost, the Drive file cannot be decrypted by anyone, including you, me or Google.** Write it down somewhere safe and keep a backup file too.

---

## Part 4: Using it, backups and troubleshooting

**Quick monthly entry:** On **Month**, use **‹ ›** at the bottom to change month. Tap a figure, type it, and press **Next/Enter** to jump to the next one. **Copy previous month** fills the whole month, and the **⧉** button on a group copies just that group. You can type sums such as `1200+350`. Use **Edit groups & lines** to add, rename, reorder (▲▼), move (⇄) or delete lines and groups.

**Month-end balances:** These are at the bottom of the Month screen. Once *every* day-to-day account (HSBC and ENBD by default) has a figure, their total becomes the next month's opening balance.

**Backups:** Go to **Settings**, then **Save backup** to get a JSON file. Do this monthly even if sync is on. **Restore backup** replaces the figures with the backup's and also syncs the restored data to Drive. **Export CSV** opens in Excel, Numbers or Google Sheets.

**About sign-in:** Google sign-in in a web app lasts about **one hour**. When it runs out, the app keeps working and saves everything on the device. It shows **"Tap to sync"**. Tap it and pick her account again, and the app catches up. Changes made offline or while signed out are queued and sync the next time.

**Wrong account warning:** If someone signs in with a different Google account (for example, your own), sync stops and a red warning names both accounts. The options are:
- **Sign out (keep everything as is):** the safe choice.
- **Use that account's data on this device:** downloads a backup first, then replaces this device's figures.
- **Move this device's data to that account:** only allowed if that account has no budget in Drive yet.

The app never combines two accounts' data on its own.

| Problem | Fix |
|---|---|
| "Access blocked: … has not completed the Google verification process" | Add her Gmail as a **test user** (Part 2.1 step 5). |
| "Error 400: origin_mismatch" or "redirect_uri_mismatch" | In **Clients**, the JavaScript origin must be exactly `https://gavinshort1977-cmyk.github.io`. |
| Sign-in window doesn't appear | Allow pop-ups for the site, then tap **Sign in** again. |
| "Sync is off" after adding the client ID | Wait 2 minutes, then close and reopen the app while online. Check that `config.js` was committed. |
| Page shows 404 | Check that Pages is set to **main** and **/docs**, and that the `docs` folder exists in the repository. |
| iPhone lost its data | iPhone may clear website data that hasn't been used for weeks. The installed home-screen app is protected better. Sync or backups get the data back. |
