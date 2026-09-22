# Aether Installer — Sword Finale & Per-Command Animations

Status: approved (build)
Scope: installer presentation layer only. No deployment logic changes.

## Why

The install ends on a plain summary. The spec asks for a "WOW moment". This adds
one: a hand-drawn ASCII **katana** — the *Thousand Demon Daggers* (魔刀千刃) from
*Scissor Seven*: a slim silver blade, black grip with blue detailing — standing
at the left of the terminal, grip at top, blade pointing down, with the master
credentials (Domain / User / Password) set beside it on the right. On a capable
terminal the blade first performs the *Thousand Demon Daggers* motion — splitting
into many daggers and reforming — then settles.

Every `aether` subcommand also gets a short, themed intro sweep so the CLI reads
as one polished tool rather than a set of scripts.

## Non-negotiables (from the operator)

- **Real ASCII/box-drawing art only. No emoji anywhere.** Not one.
- Blade is **slim** ("langsing"), 3D/volumetric, faithful to the anime, not ugly.
- Sword **left**, credentials **right**, pixel-precise column alignment.
- Animation is **bounded**, live, precise: **no "double-double"** (never two
  half-drawn frames on screen at once), **no lag** on a 1 vCPU VPS.
- Degrades cleanly: dumb terminal, no TTY, `NO_COLOR`, non-UTF-8 locale,
  `--quiet`, `AETHER_UI_ANIMATION=false` all fall back to a still frame or nothing.

## The art (UNICODE)

Block Elements + box-drawing only — every glyph is exactly one cell wide, so
columns stay true. The blade is a bright edge column plus a shaded spine column,
which is what reads as volume. Light play is supplied by the *animation*, not by
noisy static shading, so the resting blade is clean and steady.

The ASCII fallback (non-UTF-8 locale) is a plainer katana built from `| / \ + #`
that lays out identically.

## Animation contract

Reuses the engine's guarantees rather than inventing timing:

- **Rendered in the alt-screen** the installer already owns (`\033[?1049h`), so
  nothing lands in scrollback until the final still panel. Each frame is a full
  `home + clear-to-end + print` — one frame per tick — which is the same
  change-safe redraw the dashboard uses and is what makes "double-double"
  impossible: the screen is cleared before every paint.
- **Bounded**: a fixed, small frame count (~20) at a fixed step (~70 ms), total
  ≲ 1.5 s. Deterministic per-frame state (keyed on the frame index, not
  `$RANDOM`), so the shatter ripples the same way every run — precise, not jittery.
- **Not timer-as-progress**: the animation is decoration shown only *after* the
  install has actually finished (it runs from `ui_success_panel`, which install.sh
  calls only after `finalize_installation`). It never stands in for real progress.
- After the motion, leave the alt-screen and print the **persistent** still panel
  (sword + credentials) to the normal screen, so it survives in scrollback.

Non-animated capable terminal (`AETHER_UI_ANIMATION=false`): the still panel is
printed directly, no motion.

## Per-command intros

One compact engine, `ui_cmd_anim <command>`, drawn **inline** (a few lines
redrawn in place with cursor-up + erase, then fully erased before the real output
prints — no alt-screen flicker per command, no scrollback residue). Each command
selects a distinct motif + label + colour so it reads as its own animation:

| command | motif |
|---|---|
| status  | scan sweep |
| logs    | stream ticker |
| update  | edge spark travelling up the blade |
| backup  | blocks stacking |
| restore | blocks assembling |
| restart | cycle |
| doctor  | pulse |

Gated on `[ -t 1 ]` (so piped/redirected use is untouched — `aether status | grep`
sees no escape codes), not quiet, animation enabled. Disable globally with
`AETHER_UI_ANIMATION=false` or `AETHER_NO_INTRO=1`.

## Integration points

- `deploy/lib/ui-sword.sh` — new, self-contained module: the art, the finale, the
  per-command engine, and its own capability probe (so it works in the CLI, which
  does not call `ui_init`).
- `deploy/lib/core.sh` — source it alongside `ui.sh`; add a `ui_cmd_anim` no-op
  shim for installs whose lib dir predates the UI layer.
- `deploy/lib/ui.sh` — `ui_success_panel` renders the sword + credentials in rich
  mode.
- `deploy/lib/finalize.sh` — ship `ui-sword.sh` into the install's lib dir
  (`install_cli`); `print_summary` drops its duplicate credential block in rich
  mode once the sword panel has shown them (so the password is still displayed
  **exactly once**).
- `deploy/scripts/aether` — call `ui_cmd_anim` before each subcommand.

## Security

The master password is shown once at install end. The sword panel now carries
that one display in rich mode; `print_summary` suppresses its own copy so the
password appears exactly once, never in the log (the panel prints to the terminal,
like the summary always has). Password is not written to `AETHER_UI_STATE_FILE`.

## Testing

`deploy/tests/installer-ui.sh`: art contains no emoji (codepoint scan); every art
row is equal width; finale renders credentials in rich mode and none in quiet;
`ui_cmd_anim` is a no-op on a non-TTY and produces no stdout; the module sources
cleanly under `set -euo pipefail`. Live motion is verified by the operator on the
VPS — local runs are Git Bash on Windows.
