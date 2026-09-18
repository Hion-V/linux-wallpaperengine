# GNOME session crash investigation — 2026-09-18

Status: recurring native crash identified; underlying trigger not yet established.
No live compositor tests, settings changes, or speculative fixes were applied.

## Confirmed evidence

- Kernel records show Shell SIGILL crashes at 2026-09-17 20:10:56 and
  2026-09-18 01:39:15 (Europe/Amsterdam). Both stop at offset `0xafcc`
  in `libgraphene-1.0.so.0.1000.8`.
- The surviving core for PID 1643579 has `SIGILL / ILL_ILLOPN` and this main-thread stack:

  ```text
  graphene_simd4x4f_inverse
  cull_out_children_common
  meta_compositor_real_before_paint
  on_before_paint
  ```

- Offline inspection of the caller's child actor identifies its MetaWindow as
  class `cs2`, title `Counter-Strike 2`. This identifies the window being
  processed, not the application responsible for causing the fault. The user
  confirms CS2 was closed during the first crash; it is not a required trigger.
  The second crash followed roughly 3.5 hours of playing, so short crash-free
  comparisons would provide weak evidence.
- The input matrix is a valid identity matrix with an X translation of 2560.
  There are no NaNs, zero scales, or singularity in that captured matrix.
- The instruction at this offset in the installed library is
  `shufps $0x93,%xmm2,%xmm0`, bytes `0f c6 c2 93`. It is an SSE instruction
  supported by the reported Ryzen 5 7600X CPU.
- A single offline call to `graphene_matrix_inverse` with the captured matrix
  and the exact installed library succeeds and produces the expected inverse.
- `nix-store --verify-path` succeeds for the installed Graphene 1.10.8 package.
- The core omits the executable mapping's contents (`p_filesz = 0`); GDB reads
  those instruction bytes from the installed library. Consequently the core
  cannot establish whether the actual instruction bytes in RAM differed at
  the instant of the crash.
- The latest crash used GNOME Shell 50.4 and `mutter-tearing-50.4`, on
  `7.2.2-cachyos`. Its tearing source is defined in the system flake at
  `/home/andreas/nixos-config/systems/x86_64-linux/drivebystation-nix/mutter-tearing.nix`.
  The override applies GNOME Mutter MR !3797 through `prePatch`, then applies
  the local `mutter-50-tearing-compat.patch` from the same directory.
  The crashing build's derivation confirms those two `prePatch` inputs.
- The MR diff was downloaded for inspection and its SHA-256 matches the system
  flake exactly: `sha256-3up5PsHX+BSQRKb9JS5bnJLPaTGmvV55M18tKkepIng=`.
  The configuration records revision `a8d56d423edde9e6d76f6b9cab663d82c65cf1a2`
  as metadata; the fetch itself uses the MR diff URL and fixes its content by hash.
  The verified diff is available at `/tmp/lwe-mutter-3797.diff`.
- The local compatibility patch adds the tearing protocol to the build and adapts
  DMA-BUF modifier handling. The MR diff changes frame scheduling, KMS/scanout,
  compositor presentation and Wayland tearing control. Neither diff directly
  modifies `meta-cullable.c` or Graphene's inverse implementation. This does not
  exclude indirect interactions and is not a completed audit of the patch.
- Correction to the initial investigation: inspecting only the derivation's
  `patches` field missed the tearing changes in `prePatch`. The separate entry
  `a1ae71798ef1ab2e0d2f753f5c98b38b1039b056.patch` was not the tearing patch.
  Its store file was absent; that did not mean the system flake's tearing source
  was unavailable.
- Nearby Shell logs show asynchronous page flips and a rejected direct-scanout
  test (`drmModeAtomicCommit: Invalid argument`). These are context, not evidence
  that the failed scanout test caused the SIGILL.
- The reviewed kernel records do not show an OOM kill or GPU reset explaining
  these two Shell crashes.

## Interpretation and limits

The two matching native crash locations are stronger evidence than a generic
JavaScript-extension error. The captured fault does not support a singular
wallpaper-preview transform as the immediate cause. The extension can still
change rendering frequency, window stacking, and scanout eligibility and thus
expose a compositor/library/kernel interaction; finding CS2 as the current
actor does not exonerate it.

A supported instruction raising SIGILL is unexplained by the captured matrix.
Possible runtime code changes, native corruption, or CPU/kernel behavior cannot
be distinguished with this core. No hardware fault or specific upstream bug has
been demonstrated. The extension's pause/list-selection logic is not on the
captured native stack, but that alone does not exclude indirect interaction.

## Next discriminating checks

1. CS2 is already ruled out as a required trigger. Investigate the matching native
   fault and capture whether future crashes coincide with display/overview transitions.
2. During normal use, compare extension enabled with renderers stopped against
   extension disabled. Change one condition at a time; a short crash-free period
   does not establish a fix. Stopping renderers also removes their live clones.
3. If the issue follows fullscreen gaming, compare a stock Mutter build with
   the current tearing-patched build, keeping the wallpaper setup constant.
   This requires a deliberate system configuration change and was not performed.
4. For another crash, capture file-backed executable pages as well as normal
   core data, so the actual faulting bytes can be compared. This requires changing
   the Shell process's core-dump filter before the crash and was not performed.

The core export and detailed offline debugger output are under `/tmp/lwe-shell-crash.core`
and `/tmp/lwe-core-*.txt`. Core dumps contain private process memory; they are
not included in the repository.

The upstream [Mutter 50.4 culling code](https://github.com/GNOME/mutter/blob/50.4/src/compositor/meta-cullable.c)
shows that this path inverts each eligible child's transform before calculating
its visible region. The [Graphene 1.10.8 inverse implementation](https://github.com/ebassi/graphene/blob/1.10.8/include/graphene-simd4x4f.h)
provides the corresponding matrix calculation.
