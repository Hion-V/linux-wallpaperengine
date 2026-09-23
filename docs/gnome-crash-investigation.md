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

## Rapid slowdown and crash after the carousel repaint change

On 2026-09-18 at 07:24:00, Shell PID 2171499 aborted with SIGABRT.
At 07:23:44 its log reported `intel: the execbuf ioctl keeps returning ENOMEM`.
The native stack contains `_iris_batch_flush.cold`, `iris_fence_flush`,
`eglSwapBuffers`, and Mutter's stage redraw. This differs from the earlier
Graphene SIGILL crashes and indicates a graphics resource/submission failure.

The newly added JavaScript `vfunc_paint` override forced ACTOR_DIRTY for every
preview paint. It is the leading regression suspect given the reported immediate
slowdown after installation; exact resource retention has not been proven.
It has been removed, together with the preceding source-allocation relayout
experiment, restoring the pre-experiment overview implementation. Passing mock
paint tests did not establish GPU-resource safety. No live-session test was run.
The carousel flash remains unresolved. The rollback does not claim to fix the
older rare SIGILL crash.

Install the rebuilt extension before re-enabling this bridge, then log out/in
so Shell discards the old JavaScript module. The rollback does not modify the
installed extension, restart Shell, or re-enable any extensions automatically.

## Carousel flash: mixed monitor resource scales

A subsequent code review found a narrower hypothesis than window resizing or
redrawing every frame. Read-only DisplayConfig inspection reported a left monitor
at `(0, 0)` with scale 1.5 and the primary monitor at `(2560, 0)` with scale 1.0.

In Mutter 50.4:

- `clutter_actor_real_calculate_resource_scale()` selects the maximum scale of
  the stage views associated with an actor. `get_resource_scale()` rounds up,
  so these monitors can require texture scales 2 and 1 respectively.
- `update_resource_scale()` emits `resource-scale-changed` when the rounded
  value changes. The API explicitly instructs resource users to handle this
  signal when their earlier scale estimate changes before painting.
- `clutter_offscreen_effect_pre_paint()` sizes the texture using the resource
  scale. `clutter_offscreen_effect_paint()` can reuse an existing offscreen
  texture when ACTOR_DIRTY is absent. `paint_texture()` uses the *current*
  resource scale to size the cached texture on screen.
- Our `WallpaperOverviewClip` uses this offscreen effect, but its container
  does not handle `resource-scale-changed`. The bridge listens to workspace
  state adjustment, background changes and work-area changes instead; those
  do not directly cover the carousel's monitor/resource-scale changes.

If a preview's stage-view association changes from scale 2 to 1 without dirtying
its cached offscreen content, its previous texture can be displayed twice as
large and clipped to the card for a frame. This matches the reported appearance
and is consistent with a previous workspace entering the primary monitor from
the higher-scale monitor on its left. It has not been established that this
specific transition actually changes the affected actor's resource scale or
that no other redraw path invalidates the cache first.

The narrow correction to investigate is invalidating the preview container's
content on `resource-scale-changed`, using an ordinary actor redraw outside paint
rather than overriding a paint virtual function or forcing every frame dirty.
No new rendering change was applied during this inspection.

A separate clipping assumption also warrants review: `OverviewClip` maps the
whole offscreen texture's normalized coordinates directly to monitor dimensions.
Clutter can pad the offscreen paint bounds, so texture coordinates are not
necessarily exactly the container's normalized allocation. That can explain
mask-edge errors, but does not by itself establish the directional one-frame
image magnification.

### Targeted resource-scale fix

The user subsequently confirmed that the carousel flash disappears when the
secondary monitor changes from 150% to 100%, matching the primary monitor.
The preview container now handles `resource-scale-changed` by calling its own
`queue_redraw()`, which invalidates actor content rather than merely repainting
the effect's cached texture. The handler is owned by the container and removed
when it is destroyed. There is no paint virtual override, timer, or unconditional
per-frame redraw. Regression coverage checks both scale-change directions,
absence of forced redraws during ordinary refreshes, and replacement/cleanup.
The test uses mocked actors; visual confirmation at mixed scaling is still needed.

## Recurrence at 2026-09-18 11:48:17

Shell PID 2193494 again received SIGILL / ILL_ILLOPN at Graphene offset
`0xafcc`, with the same `graphene_simd4x4f_inverse` ->
`cull_out_children_common` -> `meta_compositor_real_before_paint` stack.
This is the third recorded matching rare fault, distinct from the rapid
Intel/Mesa ENOMEM abort after the reverted repaint experiment.

Although the user was playing CS2, offline inspection identifies the current
actor's window class as `code` (VS Code). The input matrix is identity plus
translation `(-16, 19, 0)`, again nonsingular and finite. Thus neither CS2's
window nor a particular translation is common to the two inspected cores.
The executable mapping again has zero captured bytes, so the faulting instruction
is reconstructed from the library on disk, not captured from RAM.

Artifacts: `/tmp/lwe-shell-crash-2193494.core` and
`/tmp/lwe-core-2193494-analysis.txt`. No compositor tests or session configuration
changes were made. The next useful crash-capture improvement remains including
file-backed executable mappings, to compare actual runtime instruction bytes.

## Bridge actor-tree audit

The bridge contained one unsafe compositor workaround: `_guardScanout()` added
an empty `Clutter.Actor` directly to each wallpaper's `MetaWindowActor`. Mutter
owns that actor's children and derives its direct-scanout candidate from their
structure. Extensions should not add children to it. This was especially
undesirable because the recurring crash is inside Mutter's recursive actor
culling, although the captured actors and matrices do not identify that empty
child as the faulting input.

The workaround has been replaced with Mutter's public, reference-counted
`Meta.Compositor.disable_unredirect()` API while wallpaper windows exist, with
one matching `enable_unredirect()` when the last registration disappears. This
keeps Shell composition active without changing `MetaWindowActor` internals.
The inhibitor is global, so direct scanout is unavailable while the live
wallpaper is connected; this favors correctness and compositor stability over
the direct-scanout optimization.

This unsafe child cannot explain the original recurring failure: the first two
matching Graphene SIGILL crashes occurred before `_guardScanout()` was committed.
The older overview integration clones the wallpaper `MetaWindowActor` into
Shell's workspace actors. `Clutter.Clone` is also used by GNOME Shell for live
window previews, and the bridge does not directly assign transforms to ordinary
application actors. Its hooks into private `WorkspaceBackground` and
`WorkspaceThumbnail` fields remain sensitive to GNOME Shell version changes,
but an incompatible hook would ordinarily produce a JavaScript exception or a
broken overview, not execute a supported SSE instruction as SIGILL.

The audit therefore found and removed a real structural hazard without proving
the cause of the three matching crashes. Their valid input matrices, varying
current windows, identical native instruction address, and missing executable
pages in the cores still point to the need for a better core capture and a
stock-Mutter comparison.
