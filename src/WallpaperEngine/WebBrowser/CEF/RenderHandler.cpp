#include "RenderHandler.h"

#include <cstring>

using namespace WallpaperEngine::WebBrowser::CEF;

RenderHandler::RenderHandler (WallpaperEngine::Render::Wallpapers::CWeb* webdata) : m_webdata (webdata) { }

// Required by CEF
void RenderHandler::GetViewRect (CefRefPtr<CefBrowser> browser, CefRect& rect) {
    rect = CefRect (0, 0, this->m_webdata->getWidth (), this->m_webdata->getHeight ());
}

// Will be executed in CEF message loop
void RenderHandler::OnPaint (
    CefRefPtr<CefBrowser> browser, PaintElementType type, const RectList& dirtyRects, const void* buffer,
    const int width, const int height
) {
    // The message pump is shared by all browsers. Never touch GL here: another
    // monitor's context/framebuffer may be current (or no context at all).
    if (!m_webdata || type != PET_VIEW || !buffer || width != getWidth () || height != getHeight ()) return;

    const auto* source = static_cast<const unsigned char*> (buffer);
    const size_t stride = static_cast<size_t> (width) * 4;
    const bool resized = width != m_paintWidth || height != m_paintHeight;
    if (resized) {
        m_paintWidth = width;
        m_paintHeight = height;
        m_pixels.resize (stride * height);
        std::memcpy (m_pixels.data (), source, m_pixels.size ());
        m_damage = CefRect (0, 0, width, height);
        return;
    }
    for (const auto& rect : dirtyRects) {
        const int x = std::clamp (rect.x, 0, width);
        const int y = std::clamp (rect.y, 0, height);
        const int right = std::clamp (rect.x + rect.width, x, width);
        const int bottom = std::clamp (rect.y + rect.height, y, height);
        if (right == x || bottom == y) continue;
        for (int row = y; row < bottom; ++row) {
            const size_t offset = row * stride + static_cast<size_t> (x) * 4;
            std::memcpy (m_pixels.data () + offset, source + offset, static_cast<size_t> (right - x) * 4);
        }
        // Merge damage across paints so a newer callback cannot lose changes
        // that have not yet been uploaded. The backing buffer retains gaps.
        const int left = m_damage.IsEmpty () ? x : std::min (x, m_damage.x);
        const int top = m_damage.IsEmpty () ? y : std::min (y, m_damage.y);
        const int r = m_damage.IsEmpty () ? right : std::max (right, m_damage.x + m_damage.width);
        const int b = m_damage.IsEmpty () ? bottom : std::max (bottom, m_damage.y + m_damage.height);
        m_damage = CefRect (left, top, r - left, b - top);
    }
}

void RenderHandler::uploadPendingPaint () {
    if (m_damage.IsEmpty () || m_paintWidth != getWidth () || m_paintHeight != getHeight ()) return;

    GLint binding, unpackBuffer, alignment, rowLength, skipPixels, skipRows;
    glGetIntegerv (GL_TEXTURE_BINDING_2D, &binding);
    glGetIntegerv (GL_PIXEL_UNPACK_BUFFER_BINDING, &unpackBuffer);
    glGetIntegerv (GL_UNPACK_ALIGNMENT, &alignment);
    glGetIntegerv (GL_UNPACK_ROW_LENGTH, &rowLength);
    glGetIntegerv (GL_UNPACK_SKIP_PIXELS, &skipPixels);
    glGetIntegerv (GL_UNPACK_SKIP_ROWS, &skipRows);
    glBindBuffer (GL_PIXEL_UNPACK_BUFFER, 0);
    glBindTexture (GL_TEXTURE_2D, texture ());
    glPixelStorei (GL_UNPACK_ALIGNMENT, 4);
    glPixelStorei (GL_UNPACK_ROW_LENGTH, m_paintWidth);
    glPixelStorei (GL_UNPACK_SKIP_PIXELS, 0);
    glPixelStorei (GL_UNPACK_SKIP_ROWS, 0);
    if (m_textureWidth != m_paintWidth || m_textureHeight != m_paintHeight) {
        glTexImage2D (GL_TEXTURE_2D, 0, GL_RGBA8, m_paintWidth, m_paintHeight, 0,
                      GL_BGRA, GL_UNSIGNED_BYTE, nullptr);
        m_textureWidth = m_paintWidth;
        m_textureHeight = m_paintHeight;
    }
    const size_t offset = (static_cast<size_t> (m_damage.y) * m_paintWidth + m_damage.x) * 4;
    glTexSubImage2D (GL_TEXTURE_2D, 0, m_damage.x, m_damage.y, m_damage.width, m_damage.height,
                     GL_BGRA, GL_UNSIGNED_BYTE, m_pixels.data () + offset);
    glPixelStorei (GL_UNPACK_ALIGNMENT, alignment);
    glPixelStorei (GL_UNPACK_ROW_LENGTH, rowLength);
    glPixelStorei (GL_UNPACK_SKIP_PIXELS, skipPixels);
    glPixelStorei (GL_UNPACK_SKIP_ROWS, skipRows);
    glBindBuffer (GL_PIXEL_UNPACK_BUFFER, unpackBuffer);
    glBindTexture (GL_TEXTURE_2D, binding);
    m_damage = CefRect ();
}

int RenderHandler::getWidth () const { return m_webdata ? m_webdata->getWidth () : 1; }

int RenderHandler::getHeight () const { return m_webdata ? m_webdata->getHeight () : 1; }

GLuint RenderHandler::texture () const { return this->m_webdata->getWallpaperTexture (); }
