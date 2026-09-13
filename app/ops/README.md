# ops — keeping Soil Viewer running

Everything here is about keeping the server alive on a Mac. None of it is application code and none
of it runs during tests. Spec §2.1.

| File | What it is |
|---|---|
| `com.soilviewer.server.plist.template` | The LaunchAgent, with placeholders for this machine's paths. Never installed as it is. |
| `install-always-on.sh` | Fills the template in, installs it to `~/Library/LaunchAgents/`, loads it, waits for the app to answer. `npm run always-on`. |
| `remove-always-on.sh` | Unloads it and moves its file aside. Nothing deleted. `npm run always-on:off`. |

**The starter lives at the repository root**, as `start-soil-viewer.command` — not here. It is the
one file in this repository meant for a person rather than for a build, and a starter you have to go
looking for is one you will not find on the day you need it. Double-click it: it opens the app if it
is running, starts it if it is not, and if it cannot, prints plain English plus the tail of the crash
log.

## What always-on means on a Mac

A user LaunchAgent: a small file in your `~/Library/LaunchAgents/` folder that tells macOS to start
the server when you log in and start it again if it ever stops. It runs as you, only while you are
logged in, and touches nothing else. It is not a system daemon, and deliberately so: with FileVault
on, nothing runs after a reboot until you unlock the disk, and that unlock is what loads the agent.
**So the honest consequence: the app returns after a reboot plus disk unlock, not after reboot
alone.** A daemon would not change that.

## Install, once

From `app/`, after `npm run build`:

    npm run always-on

To reach it from your phone over Tailscale, set your Mac's Tailscale name in the same command:

    SOIL_TAILNET_HOST=your-mac.your-tailnet.ts.net npm run always-on

and publish the port with `tailscale serve` — the README's environment table names the variables.
Check it took:

    launchctl print gui/$(id -u)/com.soilviewer.server | head -20

## Restart, stop, reload

    npm run always-on:restart     restart the running server
    npm run always-on:off         stop it, and stop it starting at login

**A change to the environment needs a full reload, not a restart.** A restart brings the process back
with the environment launchd already loaded, so after changing a port or the Tailscale name a restart
appears to do nothing. Run `npm run always-on:off` and then `npm run always-on` again.

## Where things are

- **The installed agent:** `~/Library/LaunchAgents/com.soilviewer.server.plist`. Editing the template
  in this folder changes nothing until the installer is run again.
- **The logs:** `~/.soil-viewer/launchd.out.log` — the startup banner: ports, build stamp, and the
  path of the token file, never a token — and `launchd.err.log`, the crash trace. Both are added to
  and never cleared.
- **The session tokens:** `~/.soil-viewer/tokens`, readable by you only. The banner names the file;
  nothing prints its contents.

## The gotchas

- **`dist-server/main.js` is a build artefact and is not in git.** A fresh clone has nothing for the
  agent to run until `npm run build` has been run once. The installer checks and says so.
- **System sleep stops everything.** Screen lock is fine; sleep is not. If the app should stay
  reachable from your phone with the lid closed, keep the Mac from sleeping.
- **A background process meets a silent permission wall** on `~/Documents`, `~/Desktop`, iCloud and
  external volumes — macOS refuses with no prompt at all (spec §5). Register a folder in one of those
  places and the failure is silent from the app's side. Folders elsewhere in your home directory do
  not have this problem.
- **Removing the agent removes nothing else.** `npm run always-on:off` unloads it and moves its file
  aside with a timestamp; your folders, the state directory and the logs stay where they are.
