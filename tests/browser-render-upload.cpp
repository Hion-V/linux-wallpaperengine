// Exercise the production paint handler without a browser or desktop session.
// GL stubs model pixel unpack state and capture actual uploaded pixel values.
#include "WallpaperEngine/WebBrowser/CEF/RenderHandler.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <map>

std::map<int, int> state {{GL_TEXTURE_BINDING_2D, 9}, {GL_PIXEL_UNPACK_BUFFER_BINDING, 7},
    {GL_UNPACK_ALIGNMENT, 8}, {GL_UNPACK_ROW_LENGTH, 17}, {GL_UNPACK_SKIP_PIXELS, 2}, {GL_UNPACK_SKIP_ROWS, 3}};
std::vector<unsigned char> texture;
int allocations = 0, uploads = 0, textureWidth = 0;
CefRect lastDamage;
void glGetIntegerv (int key, int* value) { *value = state.at (key); }
void glBindBuffer (int, int value) { state[GL_PIXEL_UNPACK_BUFFER_BINDING] = value; }
void glBindTexture (int, int value) { state[GL_TEXTURE_BINDING_2D] = value; }
void glPixelStorei (int key, int value) { state[key] = value; }
void glTexImage2D (int, int, int, int w, int h, int, int, int, const void*) {
    ++allocations;
    textureWidth = w;
    texture.assign (w * h * 4, 0);
}
void glTexSubImage2D (int, int, int x, int y, int w, int h, int, int, const void* data) {
    ++uploads;
    lastDamage = CefRect (x, y, w, h);
    assert (state[GL_PIXEL_UNPACK_BUFFER_BINDING] == 0);
    assert (state[GL_UNPACK_SKIP_PIXELS] == 0 && state[GL_UNPACK_SKIP_ROWS] == 0);
    const auto* pixels = static_cast<const unsigned char*> (data);
    for (int row = 0; row < h; ++row)
        std::memcpy (texture.data () + ((row + y) * textureWidth + x) * 4,
                     pixels + row * state[GL_UNPACK_ROW_LENGTH] * 4, w * 4);
}
int main () {
    using Handler = WallpaperEngine::WebBrowser::CEF::RenderHandler;
    WallpaperEngine::Render::Wallpapers::CWeb web;
    Handler handler (&web);
    const auto originalState = state;
    std::vector<unsigned char> pixels (4 * 3 * 4, 11);
    auto paint = [&] (const Handler::RectList& damage) {
        handler.OnPaint (nullptr, Handler::PET_VIEW, damage, pixels.data (), web.width, web.height);
    };
    paint ({{1, 1, 1, 1}}); // First paint must initialize the full texture.
    assert (uploads == 0 && allocations == 0); // CEF callback never touches GL.
    handler.uploadPendingPaint ();
    assert (texture == pixels && allocations == 1 && state == originalState);
    handler.uploadPendingPaint ();
    assert (uploads == 1); // No new paint means no upload.

    pixels[(1 * 4 + 1) * 4] = 22;
    paint ({{1, 1, 1, 1}});
    pixels[(2 * 4 + 3) * 4] = 33;
    paint ({{3, 2, 1, 1}}); // Accumulate two paints before rendering.
    handler.uploadPendingPaint ();
    assert (texture == pixels && allocations == 1 && uploads == 2);
    assert (lastDamage.x == 1 && lastDamage.y == 1 && lastDamage.width == 3 && lastDamage.height == 2);
    assert (state == originalState);

    handler.OnPaint (nullptr, Handler::PET_POPUP, {{0, 0, 4, 3}}, pixels.data (), 4, 3);
    handler.OnPaint (nullptr, Handler::PET_VIEW, {{0, 0, 1, 1}}, pixels.data (), 1, 1);
    handler.uploadPendingPaint ();
    assert (uploads == 2); // Popups and stale pre-resize frames cannot replace the view.

    web.width = 2; web.height = 2;
    pixels.assign (16, 44);
    paint ({{0, 0, 1, 1}});
    handler.uploadPendingPaint ();
    assert (texture == pixels && allocations == 2 && state == originalState);
    handler.detach ();
    CefRect detachedRect;
    handler.GetViewRect (nullptr, detachedRect);
    assert (detachedRect.width == 1 && detachedRect.height == 1);
    paint ({{0, 0, 2, 2}});
    handler.uploadPendingPaint ();
    assert (uploads == 3);
    std::cout << "PASS: partial uploads, accumulated damage, resize, GL state, and detached callbacks\n";
}
