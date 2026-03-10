<div align="center">

# v3.0.3 &mdash; Architecture Consolidation &amp; Cross-Distro Polish

**2026-03-07**

</div>

---

> [!NOTE]
> No breaking changes. Run `./install.sh` to apply all updates.

---

## What Changed

<table>
<thead>
<tr>
<th>Area</th>
<th>Change</th>
<th>Why</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>Architecture</strong></td>
<td>Deleted <code>linux-loader.js</code> (1&thinsp;694 lines). <abbr title="IPC handlers, session lifecycle, sessions.json persistence, transcript migration">Its responsibilities</abbr> now live exclusively in <code>ipc-handler-setup.js</code>, baked directly into <code>app.asar</code></td>
<td>Two parallel implementations drifted; the asar-baked handler was already authoritative. Removing the dead copy eliminates a persistent source of confusion and stale-reference bugs</td>
</tr>
<tr>
<td><strong>Binary&nbsp;resolution</strong></td>
<td>Added <abbr title="Linuxbrew system and user paths, mise shims, asdf shims">Linuxbrew, mise, asdf</abbr> candidates to both the Swift stub and <code>sdk_bridge.js</code>; removed hardcoded <code>/home/zack</code> fallback</td>
<td>Users managing Node.js via version managers had the CLI silently not found; the hardcoded username was a developer artifact that broke resolution for everyone else</td>
</tr>
<tr>
<td><strong>Launcher&nbsp;stability</strong></td>
<td><code>launch.sh</code> now syncs <code>frame-fix-entry.js</code> and <code>frame-fix-wrapper.js</code> from <code>stubs/</code> on every run, and adds <code>--disable-gpu</code> to the Electron invocation</td>
<td>Frame-fix changes previously required a full reinstall to take effect; GPU acceleration caused rendering artefacts on some Mesa drivers</td>
</tr>
<tr>
<td><strong>DevTools&nbsp;launcher</strong></td>
<td><code>launch-devtools.sh</code> rewritten: proper electron binary resolution (system <code>electron</code> first, AppImage fallback), <code>--disable-gpu</code>, removed hardcoded <code>squashfs-root/</code> path</td>
<td>Old script was hardcoded to AppImage layout and failed on systems with a system electron package</td>
</tr>
<tr>
<td><strong>openSUSE&nbsp;install</strong></td>
<td><code>zypper</code> now installs <code>7zip</code> + <code>nodejs-default</code> (not <code>p7zip</code> / <code>nodejs</code>)</td>
<td>Correct package names for openSUSE &mdash; old names caused install failure</td>
</tr>
<tr>
<td><strong>7z&nbsp;exit&nbsp;codes</strong></td>
<td>Exit code&nbsp;2 (&ldquo;Dangerous link path&rdquo;) treated as non-fatal warning</td>
<td>macOS DMGs include an <code>/Applications</code> symlink; 7z flags it as dangerous on Linux but extraction succeeds &mdash; <a href="https://github.com/johnzfitch/claude-cowork-linux/issues/35">#35</a></td>
</tr>
<tr>
<td><strong>i18n&nbsp;validation</strong></td>
<td>Pre-creates <code>resources/i18n/</code> before moving JSON files; warns if empty after extraction</td>
<td>Edge-case extraction orders left the directory missing, causing <code>ENOENT</code> on startup &mdash; <a href="https://github.com/johnzfitch/claude-cowork-linux/issues/33">#33</a></td>
</tr>
<tr>
<td><strong>App&nbsp;icon</strong></td>
<td><code>setup_icon()</code> extracts <abbr title="128×128, 256×256, 512×512, 1024×1024">PNG chunks</abbr> from <code>electron.icns</code> into the <abbr title="~/.local/share/icons/hicolor/">hicolor icon theme</abbr>; <code>.desktop</code> file uses theme name <code>claude</code></td>
<td>Most launchers and taskbars ignore <code>.icns</code> files; the app had no icon on KDE and Hyprland</td>
</tr>
<tr>
<td><strong>Terminal&nbsp;detach</strong></td>
<td><code>claude-desktop</code> wrapper uses <code>nohup</code> + <code>disown</code></td>
<td>Closing the terminal that launched Claude killed the process</td>
</tr>
<tr>
<td><strong>Swift&nbsp;stub&nbsp;methods</strong></td>
<td>Added <code>quickAccess.overlay</code>, <code>quickAccess.dictation</code>, <code>api.setCredentials()</code> stubs</td>
<td>Newer asar builds call these; missing stubs threw <code>TypeError: … is not a function</code> on session start &mdash; <a href="https://github.com/johnzfitch/claude-cowork-linux/issues/34">#34</a></td>
</tr>
<tr>
<td><strong>Dead&nbsp;code</strong></td>
<td>Removed non-functional <code>BrowserWindow</code> subclass patch from <code>frame-fix-wrapper.js</code></td>
<td><code>BrowserWindow</code> is non-writable on Electron&rsquo;s module export; the subclass swap never fired. Menu-bar hiding via <code>setApplicationMenu</code> interception is the working path and is kept</td>
</tr>
<tr>
<td><strong>PKGBUILD</strong></td>
<td>Updated paths for relocated scripts; added <code>--disable-gpu</code> to installed launcher</td>
<td>Path changes from v3.0.3 refactor; GPU flag for consistency with dev launchers</td>
</tr>
<tr>
<td><strong>Script&nbsp;renames</strong></td>
<td><code>test-launch.sh</code>&rarr;<code>launch.sh</code>, <code>test-launch-devtools.sh</code>&rarr;<code>launch-devtools.sh</code>, <code>test-flow.sh</code>&rarr;<code>validate.sh</code>, <code>patches/enable-cowork.py</code>&rarr;<code>enable-cowork.py</code>, <code>tools/fetch-dmg.py</code>&rarr;<code>fetch-dmg.py</code></td>
<td>The <code>test-</code> prefix implied these were temporary; they are stable tooling. Helper scripts moved to root for discoverability</td>
</tr>
<tr>
<td><strong>Test&nbsp;harness</strong></td>
<td>New <code>tests/</code> directory: <code>test-install-paths.sh</code> (8-stage install validation) and <code>Dockerfile.test</code> (Arch Linux container)</td>
<td>Automated validation for install paths, stub baking, patching, asar repack, Docker-based full install, and PKGBUILD via <code>makepkg</code></td>
</tr>
<tr>
<td><strong>.gitignore</strong></td>
<td>Added <code>mnt/</code></td>
<td>Session mount symlink directories were occasionally staged by accident</td>
</tr>
</tbody>
</table>

---

## Architecture Change: `linux-loader.js` Removed

<details>
<summary><strong>What changed and why it matters</strong></summary>

Prior to v3.0.3, the project had two parallel IPC handler implementations:

1. **`linux-loader.js`** &mdash; the original Electron main-process bootstrap (loaded via `--require`)
2. **`linux-app-extracted/ipc-handler-setup.js`** &mdash; extracted from the asar, baked back in

Over time `ipc-handler-setup.js` became authoritative: it had the session persistence fixes, transcript migration, and `ensureAsarClaudeConfigDir()`. `linux-loader.js` lagged behind and was no longer called for any critical path. It has been removed.

**If you were referencing `linux-loader.js` in custom scripts or forks**, the replacement is `linux-app-extracted/ipc-handler-setup.js`. Edit it in the extracted tree and repack via `./launch.sh` (which repacks automatically when the asar is stale).

</details>

---

## Binary Resolution Order

The stub now checks these paths in order:

<dl>
<dt><code>$CLAUDE_CODE_PATH</code></dt>
<dd>Explicit override &mdash; set this to bypass all auto-detection.</dd>
<dt><kbd>~/.config/Claude/claude-code-vm/{version}/claude</kbd></dt>
<dd>Downloaded automatically by Claude Desktop.</dd>
<dt><kbd>~/.local/bin/claude</kbd> &middot; <kbd>~/.npm-global/bin/claude</kbd></dt>
<dd>Standard npm/bun global install locations.</dd>
<dt><kbd>/usr/local/bin/claude</kbd> &middot; <kbd>/usr/bin/claude</kbd></dt>
<dd>System-wide installs.</dd>
<dt><kbd>/home/linuxbrew/.linuxbrew/bin/claude</kbd> &middot; <kbd>~/.linuxbrew/bin/claude</kbd></dt>
<dd><mark>New in v3.0.3</mark> &mdash; Linuxbrew system and user installs.</dd>
<dt><kbd>~/.local/share/mise/shims/claude</kbd> &middot; <kbd>~/.asdf/shims/claude</kbd></dt>
<dd><mark>New in v3.0.3</mark> &mdash; Version manager shims (mise, asdf).</dd>
</dl>

---

## Compatibility

| Distro | Desktop | Status |
|:-------|:--------|:-------|
| **Arch Linux** | Hyprland / KDE / GNOME | Tested &amp; Expected |
| **Ubuntu 22.04+** | GNOME / X11 | Expected |
| **Fedora 39+** | GNOME / KDE | Expected |
| **Debian 12+** | Any | Expected |
| **openSUSE** | Any | Expected (package names corrected this release) |
| **NixOS** | Any | Untested |

<details>
<summary><strong>Known caveats</strong></summary>

- GNOME Wayland: no global shortcuts (<abbr title="xdg-desktop-portal-gnome has not implemented the GlobalShortcuts portal">upstream limitation</abbr>) &mdash; set a custom shortcut in GNOME Settings instead.
- Without a <abbr title="e.g. gnome-keyring, KeePassXC, KDE Wallet">SecretService provider</abbr>, credentials fall back to <code>--password-store=basic</code>.
- The <code>/sessions</code> root symlink requires <code>sudo</code> once during install.

</details>

---

## Install / Upgrade

<dl>
<dt><kbd>install.sh</kbd> (recommended)</dt>
<dd>

```bash
# Fresh install
git clone https://github.com/johnzfitch/claude-cowork-linux.git
cd claude-cowork-linux && ./install.sh

# Upgrade
cd ~/.local/share/claude-desktop && git pull && ./install.sh
```

</dd>
<dt><kbd>AUR</kbd> (Arch Linux)</dt>
<dd>

```bash
yay -S claude-cowork-linux
```

</dd>
<dt><kbd>curl</kbd> pipe</dt>
<dd>

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install.sh)
```

</dd>
</dl>

Run preflight after upgrading:

```bash
claude-desktop --doctor
```

---

## Commits since v3.0.2

| Commit | Summary |
|:-------|:--------|
| `f5be3e3` | refactor: remove linux-loader.js, update all path references |
| `aa87b26` | refactor(frame-fix): remove non-functional BrowserWindow patch |
| `8be7071` | revert: remove update.sh &mdash; out of scope, security concern |
| `9e2a41b` | feat: icon fix, terminal detach, update script |
| `603fc9c` | docs: add alpham8 as contributor |
| `73e13ea` | Merge pull request #36 |
| `62719dc` | fix: harden stubs and cross-distro compatibility (review round 2) |
| `113ab91` | fix: address issues #28, #33, #34, #35 and incorporate PR #32 improvements |
| `4449da3` | docs: remove Max plan requirement from README |
| `832a1a8` | docs: update README with accurate v3.0.2 details |

---

## Contributors

- **[@alpham8](https://github.com/alpham8)** &mdash; openSUSE package name fixes, binary resolution paths for Linuxbrew/mise/asdf, Swift stub method stubs ([PR&nbsp;#32](https://github.com/johnzfitch/claude-cowork-linux/pull/32), [#36](https://github.com/johnzfitch/claude-cowork-linux/pull/36))
- **[@matiasandina](https://github.com/matiasandina)** &mdash; icon fix and terminal detach proposals that shipped in this release ([#37](https://github.com/johnzfitch/claude-cowork-linux/issues/37))

---

<div align="center">

**[Full diff](https://github.com/johnzfitch/claude-cowork-linux/compare/v3.0.2...v3.0.3)** &middot; **[README](https://github.com/johnzfitch/claude-cowork-linux#readme)** &middot; **[Issues](https://github.com/johnzfitch/claude-cowork-linux/issues)**

MIT License &mdash; See [LICENSE](LICENSE) for details.

</div>
