#pragma once

#include "WallpaperEngine/Render/Wallpapers/CWeb.h"
#include "include/cef_browser.h"

namespace WallpaperEngine::Render::Wallpapers {
class CWeb;
}

namespace WallpaperEngine::WebBrowser::CEF {
// *************************************************************************
//! \brief Private implementation to handle CEF events to draw the web page.
// *************************************************************************
class RenderHandler : public CefRenderHandler {
public:
    explicit RenderHandler (WallpaperEngine::Render::Wallpapers::CWeb* webdata);

    //! \brief
    ~RenderHandler () override = default;

    //! \brief CefRenderHandler interface
    void GetViewRect (CefRefPtr<CefBrowser> browser, CefRect& rect) override;

    //! \brief CefRenderHandler interface
    //! Update the OpenGL texture.
    void OnPaint (
	CefRefPtr<CefBrowser> browser, PaintElementType type, const RectList& dirtyRects, const void* buffer, int width,
	int height
    ) override;

    // Called with this wallpaper's GL context current; CEF callbacks only stage pixels.
    void uploadPendingPaint ();
    void detach () { m_webdata = nullptr; }

    //! \brief CefBase interface
    IMPLEMENT_REFCOUNTING (RenderHandler);

private:
    WallpaperEngine::Render::Wallpapers::CWeb* m_webdata = nullptr;

    std::vector<unsigned char> m_pixels;
    CefRect m_damage;
    int m_paintWidth = 0;
    int m_paintHeight = 0;
    int m_textureWidth = 0;
    int m_textureHeight = 0;

    [[nodiscard]] int getWidth () const;
    [[nodiscard]] int getHeight () const;

    //! \brief Return the OpenGL texture handle
    [[nodiscard]] GLuint texture () const;
};
} // namespace WallpaperEngine::WebBrowser::CEF