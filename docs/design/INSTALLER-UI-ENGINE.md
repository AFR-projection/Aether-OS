# Aether Installer UI Engine — Design

Status: **PROPOSAL — menunggu approval sebelum implementasi.**
Scope: presentation layer installer (`deploy/lib/ui.sh`, `deploy/lib/ui-state.sh`) + titik prompt di `install.sh`, `interactive-setup.sh`, `finalize.sh`.

Non-negotiable dari brief: **deployment engine tidak di-rewrite.** UI tetap layer di atas engine. State nyata tetap satu-satunya source of truth. Tidak ada fake progress.

---

## 1. Diagnosis — kenapa keluhan muncul

### 1a. "Animasi double-double" (panel ke-render puluhan/ratusan kali)

Akar masalah ada di `ui_frame_flush()` (`ui.sh:574`). Strategi redraw sekarang:

- Frame pertama: `\0337` (DECSC — **simpan posisi cursor absolut**).
- Frame berikutnya: `\0338` (DECRC — restore ke posisi tersimpan) lalu `\033[J` (hapus sampai akhir layar), lalu print ulang.

Panel Aether tingginya **~17–20 baris**. Di terminal SSH standar (24 baris) atau saat cursor sudah di dekat bawah layar, begitu frame di-print terminal **scroll ke atas**. Posisi yang tadi disimpan DECSC ikut tergeser keluar layar. DECRC lalu restore ke titik yang salah (atau di-clamp terminal), `\033[J` menghapus region yang salah, dan reprint jatuh di bawah frame lama → **muncul salinan penuh panel**. Ini menumpuk.

Pemicunya per detik: `ui_row_bar()` (`ui.sh:817-819`) untuk bar indeterminate pakai
`offset=$(( $(date +%s) % (width - 5) ))`. Tiap detik `offset` berubah → `ui_render_dashboard_if_changed` melihat frame beda → redraw. Selama install 36 menit itu **ribuan redraw**, dan tiap redraw yang jatuh saat layar sudah scroll = satu panel duplikat.

Faktor ketiga yang memperparah: **stray output**. Di mode rich, command yang TIDAK dibungkus `ui_run` menulis langsung ke stdout dan menggeser layar:

- `configure_firewall` → `ufw allow ...` (`finalize.sh:119-121`)
- `create_systemd_unit` → `systemctl` + `tee` (`finalize.sh:201-230`)
- `write_initial_deployment_metadata` → `git` (`finalize.sh:343-345`)
- `create_master_user`, `install_local_agent`

Komentar di `ui_frame_flush` mengklaim DECRC kebal stray output — itu **hanya benar selama layar tidak scroll**. Begitu scroll, anchor absolut pecah.

**Kesimpulan: flooding = anchor absolut yang pecah saat scroll × redraw paksa tiap detik × stray output tak-terbungkus. Tiga faktor yang saling memperkuat.**

### 1b. Konfirmasi "di tengah-tengah"

Urutan sekarang (`install.sh:278-323`):

1. `run_preflight`
2. `run_interactive_setup` → `prompt_domain`, `prompt_master_account`, `prompt_host_access`
3. Prompt "Resume the previous install? [Y/n]" (`install.sh:300`)
4. `dependencies` → `configure` → `deploy` → **`finalize`**
5. **Di dalam `finalize_installation` → `configure_firewall` → `confirm "Enable UFW now?"` (`finalize.sh:127`)** ← ini yang muncul di tengah, ~menit ke-30+.

Jadi hanya **satu** prompt yang benar-benar salah posisi: **Enable UFW**. Sisanya sudah di depan. (Prompt DNS-retry di dalam `prompt_domain` hanya muncul kalau DNS gagal — itu bagian dari setup domain, wajar di depan.)

### 1c. "Animasinya jelek"

Border default `+`/`-`, tidak ada wordmark, hierarki tipografi tipis, glyph seadanya. Perlu identitas visual Aether sendiri.

---

## 2. Rencana perbaikan

### 2A. Redraw model scroll-safe (fix flooding)

Ganti anchor absolut DECSC/DECRC dengan **relative cursor-up-N** (pola yang dipakai inline-renderer TUI produksi: bubbletea inline, pnpm, docker):

- Setelah print frame N baris, cursor ada tepat di bawah frame.
- Redraw berikutnya: `\033[<N>A` (naik N baris relatif dari posisi sekarang), `\033[J` (hapus ke bawah), print ulang.
- Relatif terhadap posisi cursor saat ini → **scroll tidak merusaknya**, selama (a) frame muat di tinggi terminal dan (b) tidak ada yang menulis ke terminal di antara dua frame.

Dua syarat itu ditegakkan:

1. **Bound tinggi frame ke tinggi terminal.** Hitung `UI_FRAME_LINES`; jika > `UI_ROWS - margin`, panel dipangkas (baris feed/section opsional dibuang, sudah ada mekanismenya lewat `UI_ROWS`) — dan jika tetap tidak muat, **fallback otomatis ke mode plain** (streaming baris). Lebih baik plain yang rapi daripada panel yang robek.
2. **Isolasi output.** Semua command yang sekarang menulis langsung ke stdout di stage rich dibungkus `ui_run` (atau outputnya diarahkan ke log). Target: `ufw`, `systemctl`, `tee`, `git`, master-user, host-agent. Dengan ini tidak ada baris liar yang jatuh di antara frame → hitungan N selalu akurat.

Tambahan: **turunkan frekuensi repaint**. Redraw dipicu perubahan frame; animasi 1 Hz adalah pemicu utama. Repaint jadi benar (relatif) DAN lebih jarang — sweep hanya maju tiap ~800ms, dan repaint di-skip kalau teks frame identik (sudah ada di `ui_render_dashboard_if_changed`). CPU di 1 vCPU turun, tidak ada leak (tetap fork-free `printf -v`).

Fallback non-TTY / `curl | bash` tanpa TTY / CI / redirect / pipe: `ui_capability_detect` sudah memilih plain saat `[ -t 1 ]` gagal. Ini tidak berubah. Yang berubah: mode rich sekarang aman walau terjadi scroll.

### 2B. Batasi semua konfirmasi ke depan

- Tambah pertanyaan UFW ke `run_interactive_setup` (di `interactive-setup.sh`), simpan jawaban ke `AETHER_ENABLE_UFW`.
- `configure_firewall` (`finalize.sh:127`) berhenti prompt; baca `AETHER_ENABLE_UFW` yang sudah dikumpulkan di depan. `--yes`/non-interaktif tetap seperti sekarang.
- Hasil: setelah blok setup awal, install jalan tanpa interupsi sampai selesai.

### 2C. Identitas visual Aether (polish)

Ambil *inspirasi* (bukan copy) dari termui / inkui / charm.land / ui-layouts:

- **Wordmark**: ASCII block-letter "AETHER" digambar sekali di awal (rich+unicode), fallback teks biasa. Tidak norak, tidak Matrix.
- **Border**: rounded box-drawing `╭ ╮ ╰ ╯ │ ─` + konektor `├ ┤`, fallback ASCII `+ - |`.
- **Glyph status**: `✓` sukses, `✕` gagal, `◉` running, `○` waiting, `⊘` skipped — fallback ASCII.
- **Spinner**: braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, fallback `|/-\`.
- **Progress bar**: `█` penuh / `░` kosong (sudah ada), fill warna accent.
- **Sub-step tree** untuk Host Agent: `├─ Registering host ✓` dst — dari state agent nyata, bukan karangan.
- **Palet warna**: accent cyan (`38;5;39`), ok green, fail red, dim gray. Hormati `NO_COLOR`.
- Hierarki tipografi: section header bold + rule, spacing konsisten.

Semua glyph/warna sudah punya jalur fallback di `ui_style_init` + deteksi Unicode/locale — polish ini menambah set glyph, bukan mengubah arsitektur deteksi.

---

## 3. Yang TIDAK berubah (jaminan anti-regresi)

- Urutan stage, checkpoint/resume (`install.state`), `run_stage`, `mark_done`.
- Source of truth GitHub, semantik `aether update`, rollback, migrasi DB, deployment Docker, pairing Host Agent, security model, CLI.
- State engine `ui-state.sh` tetap presentation-only: kalau seluruh fungsinya di-no-op, installer harus tetap identik. Progress tetap dari operasi nyata.
- Redaksi secret (`ui_redact`) tetap; UFW/prompt baru tidak memunculkan secret.

Satu-satunya perubahan semantik: `configure_firewall` membaca `AETHER_ENABLE_UFW` alih-alih prompt in-place. Alasan: memindah konfirmasi ke depan (permintaan eksplisit). Dampak: nol untuk `--yes` (sudah `AETHER_YES`); untuk interaktif, jawaban dikumpulkan lebih awal. Tidak mengubah apakah UFW enable — hanya *kapan* ditanya.

---

## 4. Testing (regression + baru), lalu bukti

Ke `deploy/tests/installer-ui.sh` (yang sudah ada):

1. TTY vs non-TTY fallback · 2. `--no-animation` · 3. `--quiet` · 4. `--verbose`
5. Deteksi ANSI/Unicode + fallback ASCII · 6. Lifecycle stage (waiting→running→success/failed/skipped)
7. Render progress (determinate + indeterminate, tidak pernah 100% saat RUNNING)
8. **Frame tidak pernah melebihi tinggi terminal (regresi flooding)** · 9. **Redraw relatif: N baris naik = N baris frame**
10. SIGINT cleanup + restore cursor · 11. Exit code preserved · 12. Redaksi secret
13. No fake progress (tidak ada total yang dikarang) · 14. **Prompt UFW terbaca dari `AETHER_ENABLE_UFW`, tidak prompt in-place**

Lalu: `bash -n` semua script deploy, `shellcheck` (kalau ada), test deploy existing, dan verifikasi build repo. **Bukti hasil test dilampirkan**, bukan klaim "works". E2E VPS di dataku.id kalau memungkinkan.

---

## 5. Risiko

- Relative cursor-up bergantung pada isolasi output. Jika ada satu command rich yang lupa dibungkus dan menulis ke stdout, hitungan baris meleset satu kali. Mitigasi: audit semua call-site di stage rich + fallback plain saat frame tak muat.
- Wordmark ASCII di terminal sangat sempit (<64 kol) — sudah ada clamp lebar; wordmark hanya digambar bila lebar cukup, selain itu teks biasa.
