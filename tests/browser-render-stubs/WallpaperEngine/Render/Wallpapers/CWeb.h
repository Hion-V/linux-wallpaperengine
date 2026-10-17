#pragma once
#include <algorithm>
#include <cstddef>
#include <vector>
using GLuint = unsigned int;
using GLint = int;
enum {
    GL_TEXTURE_BINDING_2D, GL_PIXEL_UNPACK_BUFFER_BINDING, GL_UNPACK_ALIGNMENT,
    GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_PIXELS, GL_UNPACK_SKIP_ROWS,
    GL_PIXEL_UNPACK_BUFFER, GL_TEXTURE_2D, GL_RGBA8, GL_BGRA, GL_UNSIGNED_BYTE
};
void glGetIntegerv (int, int*);
void glBindBuffer (int, int);
void glBindTexture (int, int);
void glPixelStorei (int, int);
void glTexImage2D (int, int, int, int, int, int, int, int, const void*);
void glTexSubImage2D (int, int, int, int, int, int, int, int, const void*);
namespace WallpaperEngine::Render::Wallpapers {
class CWeb {
public:
    int width = 4, height = 3;
    int getWidth () const { return width; }
    int getHeight () const { return height; }
    GLuint getWallpaperTexture () const { return 42; }
};
}
