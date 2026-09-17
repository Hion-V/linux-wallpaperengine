#include "WaylandOutputViewport.h"
#include "WallpaperEngine/Logging/Log.h"

#define class _class
#define namespace _namespace
#define static
extern "C" {
#include "wlr-layer-shell-unstable-v1-protocol.h"
#include "xdg-output-unstable-v1-protocol.h"
#include "xdg-shell-protocol.h"
}
#undef class
#undef namespace
#undef static

using namespace WallpaperEngine::Render::Drivers;
using namespace WallpaperEngine::Render::Drivers::Output;

static void handleLSConfigure (void* data, zwlr_layer_surface_v1* surface, uint32_t serial, uint32_t w, uint32_t h) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);
    viewport->size = { w, h };
    viewport->logicalSize = { w, h };
    viewport->viewport = { 0, 0, viewport->size.x * viewport->scale, viewport->size.y * viewport->scale };
    viewport->resize ();

    zwlr_layer_surface_v1_ack_configure (surface, serial);
}

static void handleLSClosed (void* data, zwlr_layer_surface_v1* surface) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);

    viewport->getDriver ()->onLayerClose (viewport);
}

static void geometry (
    void* data, wl_output* output, int32_t x, int32_t y, int32_t width_mm, int32_t height_mm, int32_t subpixel,
    const char* make, const char* model, int32_t transform
) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);
    // only use geometry position as fallback if xdg-output hasn't provided one
    if (!viewport->hasXdgLogicalPosition) {
	viewport->globalPosition = { x, y };
    }
    sLog.debug ("SPAN DEBUG geometry: output '", viewport->name, "' position=(", x, ",", y, ") transform=", transform);
}

static void mode (void* data, wl_output* output, uint32_t flags, int32_t width, int32_t height, int32_t refresh) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);

    if (!(flags & WL_OUTPUT_MODE_CURRENT) || viewport->xdgToplevel) return;

    // update viewport size (physical pixels; logicalSize comes from xdg-output or layer shell configure)
    viewport->size = { width, height };
    viewport->viewport = { 0, 0, viewport->size.x * viewport->scale, viewport->size.y * viewport->scale };

    if (viewport->layerSurface || viewport->xdgToplevel) {
	viewport->resize ();
    }

    if (viewport->initialized) {
	viewport->getDriver ()->getOutput ().reset ();
    }
}

static void done (void* data, wl_output* wl_output) { static_cast<WaylandOutputViewport*> (data)->initialized = true; }

static void scale (void* data, wl_output* wl_output, int32_t scale) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);

    viewport->scale = scale;

    if (viewport->layerSurface || viewport->xdgToplevel) {
	viewport->resize ();
    }

    if (viewport->initialized) {
	viewport->getDriver ()->getOutput ().reset ();
    }
}

static void name (void* data, wl_output* wl_output, const char* name) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);

    if (name) {
	viewport->name = name;
    }

    // ensure the output is updated with the new name too
    viewport->getDriver ()->getOutput ().reset ();
}

static void description (void* data, wl_output* wl_output, const char* description) {
    // ignored
}

static void surfaceFrameCallback (void* data, struct wl_callback* cb, uint32_t time) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);

    wl_callback_destroy (cb);

    viewport->frameCallback = nullptr;
    if (viewport->closed) return;
    viewport->rendering = true;
    viewport->getDriver ()->getApp ().update (viewport);
    viewport->rendering = false;
}

constexpr struct wl_callback_listener frameListener = { .done = surfaceFrameCallback };

constexpr wl_output_listener outputListener
    = { .geometry = geometry, .mode = mode, .done = done, .scale = scale, .name = name, .description = description };

constexpr struct zwlr_layer_surface_v1_listener layerSurfaceListener = {
    .configure = handleLSConfigure,
    .closed = handleLSClosed,
};

static void xdgOutputLogicalPosition (void* data, struct zxdg_output_v1* xdg_output, int32_t x, int32_t y) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);
    viewport->globalPosition = { x, y };
    viewport->hasXdgLogicalPosition = true;
    sLog.debug ("SPAN DEBUG xdg-output logical_position: '", viewport->name, "' position=(", x, ",", y, ")");
}

static void xdgOutputLogicalSize (void* data, struct zxdg_output_v1* xdg_output, int32_t width, int32_t height) {
    const auto viewport = static_cast<WaylandOutputViewport*> (data);
    viewport->logicalSize = { width, height };
    if (viewport->initialized) {
	viewport->getDriver ()->getOutput ().reset ();
    }
}

static void xdgOutputDone (void* data, struct zxdg_output_v1* xdg_output) {
    // deprecated since xdg-output v3, compositor uses wl_output.done instead
}

static void xdgOutputName (void* data, struct zxdg_output_v1* xdg_output, const char* name) {
    if (name) static_cast<WaylandOutputViewport*> (data)->name = name;
}

static void xdgOutputDescription (void* data, struct zxdg_output_v1* xdg_output, const char* description) {
    // ignored
}

constexpr struct zxdg_output_v1_listener xdgOutputListener = {
    .logical_position = xdgOutputLogicalPosition,
    .logical_size = xdgOutputLogicalSize,
    .done = xdgOutputDone,
    .name = xdgOutputName,
    .description = xdgOutputDescription,
};

WaylandOutputViewport::WaylandOutputViewport (
    WaylandOpenGLDriver* driver, uint32_t waylandName, struct wl_registry* registry
) : OutputViewport ({ 0, 0, 0, 0 }, "", true), size ({ 0, 0 }), waylandName (waylandName), m_driver (driver) {
    // setup output listener
    this->output = static_cast<wl_output*> (wl_registry_bind (registry, waylandName, &wl_output_interface, 4));
    wl_output_add_listener (output, &outputListener, this);
}

void WaylandOutputViewport::setupXdgOutput (zxdg_output_manager_v1* manager) {
    this->xdgOutput = zxdg_output_manager_v1_get_xdg_output (manager, this->output);
    zxdg_output_v1_add_listener (this->xdgOutput, &xdgOutputListener, this);
}

void WaylandOutputViewport::setupLS () {
    surface = wl_compositor_create_surface (m_driver->getWaylandContext ()->compositor);

    zwlr_layer_shell_v1_layer wlrLayer;
    switch (m_driver->getApp ().getContext ().settings.render.wayland.layer) {
	case WallpaperEngine::Application::ApplicationContext::WAYLAND_LAYER_BACKGROUND:
	    wlrLayer = ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND;
	    break;
	case WallpaperEngine::Application::ApplicationContext::WAYLAND_LAYER_TOP:
	    wlrLayer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
	    break;
	case WallpaperEngine::Application::ApplicationContext::WAYLAND_LAYER_OVERLAY:
	    wlrLayer = ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY;
	    break;
	case WallpaperEngine::Application::ApplicationContext::WAYLAND_LAYER_BOTTOM:
	default:
	    wlrLayer = ZWLR_LAYER_SHELL_V1_LAYER_BOTTOM;
	    break;
    }

    layerSurface = zwlr_layer_shell_v1_get_layer_surface (
	m_driver->getWaylandContext ()->layerShell, surface, output, wlrLayer, "linux-wallpaperengine"
    );

    if (!layerSurface) {
	sLog.exception ("Failed to get a layer surface");
    }

    wl_region* region = wl_compositor_create_region (m_driver->getWaylandContext ()->compositor);
    if (m_driver->getApp ().getContext ().settings.mouse.enabled) {
	wl_region_add (region, 0, 0, INT32_MAX, INT32_MAX);
    }

    // Mark the surface as fully opaque so the compositor can skip rendering
    // anything below it and avoid alpha-blending. Wallpapers are by definition
    // the bottommost visible content, so this is always a win.
    wl_region* opaqueRegion = wl_compositor_create_region (m_driver->getWaylandContext ()->compositor);
    wl_region_add (opaqueRegion, 0, 0, INT32_MAX, INT32_MAX);
    wl_surface_set_opaque_region (surface, opaqueRegion);
    wl_region_destroy (opaqueRegion);

    zwlr_layer_surface_v1_set_size (layerSurface, 0, 0);
    zwlr_layer_surface_v1_set_anchor (
	layerSurface,
	ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT | ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP
	    | ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM
    );
    zwlr_layer_surface_v1_set_keyboard_interactivity (layerSurface, false);
    zwlr_layer_surface_v1_add_listener (layerSurface, &layerSurfaceListener, this);
    zwlr_layer_surface_v1_set_exclusive_zone (layerSurface, -1);
    wl_surface_set_input_region (surface, region);
    wl_region_destroy (region);
    wl_surface_commit (surface);
    wl_display_roundtrip (m_driver->getWaylandContext ()->display);

    eglWindow = wl_egl_window_create (surface, size.x * scale, size.y * scale);
    eglSurface = m_driver->getEGLContext ()->eglCreatePlatformWindowSurfaceEXT (
	m_driver->getEGLContext ()->display, m_driver->getEGLContext ()->config, eglWindow, nullptr
    );
    wl_surface_commit (surface);
    wl_display_roundtrip (m_driver->getWaylandContext ()->display);
    wl_display_flush (m_driver->getWaylandContext ()->display);

    static const auto XCURSORSIZE = getenv ("XCURSOR_SIZE") ? std::stoi (getenv ("XCURSOR_SIZE")) : 24;
    const auto PRCURSORTHEME
	= wl_cursor_theme_load (getenv ("XCURSOR_THEME"), XCURSORSIZE * scale, m_driver->getWaylandContext ()->shm);

    if (!PRCURSORTHEME) {
	sLog.exception ("Failed to get a cursor theme");
    }

    pointer = wl_cursor_theme_get_cursor (PRCURSORTHEME, "left_ptr");
    cursorSurface = wl_compositor_create_surface (m_driver->getWaylandContext ()->compositor);

    if (!cursorSurface) {
	sLog.exception ("Failed to get a cursor surface");
    }

    if (eglMakeCurrent (
	    m_driver->getEGLContext ()->display, eglSurface, eglSurface, m_driver->getEGLContext ()->context
	)
	== EGL_FALSE) {
	sLog.exception ("Failed to make egl current");
    }

    this->m_driver->getOutput ().reset ();
}

static void gnomeConfigure (void* data, xdg_surface* surface, uint32_t serial) {
    auto* viewport = static_cast<WaylandOutputViewport*> (data);
    xdg_surface_ack_configure (surface, serial);
    viewport->configured = true;
    viewport->viewport = { 0, 0, viewport->size.x * viewport->scale, viewport->size.y * viewport->scale };
    viewport->resize ();
}

static void gnomeToplevelConfigure (void* data, xdg_toplevel*, int32_t width, int32_t height, wl_array*) {
    auto* viewport = static_cast<WaylandOutputViewport*> (data);
    if (width > 0 && height > 0) {
        viewport->size = { width, height };
        viewport->logicalSize = viewport->size;
    }
}

static void gnomeClose (void* data, xdg_toplevel*) {
    auto* viewport = static_cast<WaylandOutputViewport*> (data);
    viewport->getDriver ()->onLayerClose (viewport);
}

void WaylandOutputViewport::setupGnome () {
    // Register before committing the surface so Shell can classify it before mapping.
    const auto token = m_driver->gnomeBridge->registerOutput (name);
    auto* wayland = m_driver->getWaylandContext ();
    auto* egl = m_driver->getEGLContext ();
    surface = wl_compositor_create_surface (wayland->compositor);
    xdgSurface = xdg_wm_base_get_xdg_surface (wayland->xdgShell, surface);
    static const xdg_surface_listener surfaceListener = { .configure = gnomeConfigure };
    xdg_surface_add_listener (xdgSurface, &surfaceListener, this);
    xdgToplevel = xdg_surface_get_toplevel (xdgSurface);
    static const xdg_toplevel_listener toplevelListener = {
        .configure = gnomeToplevelConfigure, .close = gnomeClose
    };
    xdg_toplevel_add_listener (xdgToplevel, &toplevelListener, this);
    xdg_toplevel_set_app_id (xdgToplevel, token.c_str ());
    xdg_toplevel_set_title (xdgToplevel, "Linux Wallpaper Engine");
    // Empty input region lets desktop clicks reach GNOME and desktop icon extensions.
    auto* region = wl_compositor_create_region (wayland->compositor);
    wl_surface_set_input_region (surface, region);
    wl_region_destroy (region);
    size = logicalSize.x > 0 && logicalSize.y > 0 ? logicalSize : size / scale;
    wl_surface_set_buffer_scale (surface, scale);
    wl_surface_commit (surface);
    while (!configured && !closed) {
        if (wl_display_dispatch (wayland->display) < 0)
            sLog.exception ("GNOME disconnected before configuring wallpaper");
    }
    if (closed) sLog.exception ("GNOME closed the wallpaper during setup");
    eglWindow = wl_egl_window_create (surface, size.x * scale, size.y * scale);
    if (!eglWindow) sLog.exception ("Failed to create GNOME wallpaper EGL window");
    eglSurface = egl->eglCreatePlatformWindowSurfaceEXT (egl->display, egl->config, eglWindow, nullptr);
    if (!eglWindow || eglSurface == EGL_NO_SURFACE)
        sLog.exception ("Failed to create GNOME wallpaper EGL surface");
    if (!eglMakeCurrent (egl->display, eglSurface, eglSurface, egl->context))
        sLog.exception ("Failed to make GNOME wallpaper EGL context current");
    m_driver->getOutput ().reset ();
}

WaylandOpenGLDriver* WaylandOutputViewport::getDriver () const { return this->m_driver; }

void WaylandOutputViewport::makeCurrent () {
    const EGLBoolean result = eglMakeCurrent (
	m_driver->getEGLContext ()->display, eglSurface, eglSurface, m_driver->getEGLContext ()->context
    );

    if (result == EGL_FALSE) {
	sLog.error ("Couldn't make egl current");
    }
}

void WaylandOutputViewport::swapOutput () {
    this->callbackInitialized = true;

    this->makeCurrent ();
    frameCallback = wl_surface_frame (surface);
    wl_callback_add_listener (frameCallback, &frameListener, this);
    eglSwapBuffers (m_driver->getEGLContext ()->display, this->eglSurface);
    wl_surface_set_buffer_scale (surface, scale);
    wl_surface_damage_buffer (surface, 0, 0, INT32_MAX, INT32_MAX);
    wl_surface_commit (surface);
}

void WaylandOutputViewport::resize () {
    if (!this->eglWindow) {
	return;
    }

    viewport = { 0, 0, size.x * scale, size.y * scale };
    wl_surface_set_buffer_scale (surface, scale);
    wl_egl_window_resize (this->eglWindow, this->size.x * this->scale, this->size.y * this->scale, 0, 0);

    this->getDriver ()->getOutput ().reset ();
}
