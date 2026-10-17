#pragma once
#include <vector>
class CefBrowser {};
template<typename T> using CefRefPtr = T*;
struct CefRect {
    int x = 0, y = 0, width = 0, height = 0;
    CefRect () = default;
    CefRect (int a, int b, int c, int d) : x (a), y (b), width (c), height (d) {}
    bool IsEmpty () const { return width <= 0 || height <= 0; }
};
class CefRenderHandler {
public:
    enum PaintElementType { PET_VIEW, PET_POPUP };
    using RectList = std::vector<CefRect>;
    virtual ~CefRenderHandler () = default;
    virtual void GetViewRect (CefRefPtr<CefBrowser>, CefRect&) = 0;
    virtual void OnPaint (CefRefPtr<CefBrowser>, PaintElementType, const RectList&, const void*, int, int) = 0;
};
#define IMPLEMENT_REFCOUNTING(T)
