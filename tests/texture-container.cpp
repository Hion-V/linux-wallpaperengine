#include "WallpaperEngine/Data/Parsers/TextureParser.h"

#include <cassert>
#include <fstream>
#include <sstream>

using namespace WallpaperEngine::Data::Assets;
using WallpaperEngine::Data::Parsers::TextureParser;
using WallpaperEngine::Data::Utils::BinaryReader;

namespace {
void word (std::ostream& out, uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) {
        out.put (static_cast<char> (value >> shift));
    }
}

void checkContainer (bool extended, FIF format, uint32_t flags, bool video) {
    auto stream = std::make_shared<std::stringstream> ();
    stream->write ("TEXV0005\0TEXI0001\0", 18);
    for (uint32_t value : { 0u, flags, 2u, 2u, 2u, 2u, 0u }) {
        word (*stream, value);
    }
    stream->write ("TEXB0004\0", 9);
    word (*stream, 1); // images
    word (*stream, static_cast<uint32_t> (format));
    word (*stream, extended);
    word (*stream, 1); // mipmaps
    if (extended) {
        word (*stream, 1);
        word (*stream, 0);
        *stream << "{\"condition\":\"enabled\"}";
        stream->put ('\0');
        word (*stream, 4);
    }
    for (uint32_t value : { 2u, 2u, 0u, 4u, 4u }) {
        word (*stream, value);
    }
    stream->write ("data", 4);
    const auto texture = TextureParser::parse (BinaryReader (stream));
    assert (texture->isVideoMp4 == video);
    assert (texture->freeImageFormat == format);
    const auto& mip = texture->images.at (0).at (0);
    assert (mip->width == 2 && mip->height == 2);
    assert (mip->uncompressedSize == 4);
    assert (std::string (mip->uncompressedData.get (), 4) == "data");
    assert (mip->json.empty () != extended);
}
}

int main (int argc, char** argv) {
    checkContainer (false, FIF_PNG, 0, false);
    checkContainer (true, FIF_PNG, 0, false);
    checkContainer (true, FIF_UNKNOWN, 0, false);
    checkContainer (true, FIF_MP4, 0, true);
    checkContainer (true, FIF_UNKNOWN, TextureFlags_Video, true);
    for (int i = 1; i < argc; ++i) {
        const auto texture = TextureParser::parse (BinaryReader (std::make_shared<std::ifstream> (argv[i], std::ios::binary)));
        assert (!texture->isVideoMp4);
        assert (texture->images.at (0).at (0)->width == texture->textureWidth);
    }
}
