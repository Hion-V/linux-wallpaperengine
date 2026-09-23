#include <catch2/catch_test_macros.hpp>

#include "WallpaperEngine/Data/Model/Property.h"
#include "WallpaperEngine/Data/Parsers/PropertyParser.h"

using WallpaperEngine::Data::JSON::JSON;
using WallpaperEngine::Data::Model::DynamicValue;
using WallpaperEngine::Data::Parsers::PropertyParser;

TEST_CASE ("Bool properties without a value default to false") {
    const JSON propertyData = {
	{ "type", "bool" },
	{ "text", "Enabled" },
    };

    const auto property = PropertyParser::parse (propertyData, "enabled");

    REQUIRE (property != nullptr);
    CHECK (property->getType () == DynamicValue::Boolean);
    CHECK_FALSE (property->getBool ());
}

TEST_CASE ("Directory properties are parsed as file-like properties") {
    const JSON propertyData = {
	{ "type", "directory" },
	{ "text", "Folder" },
    };

    const auto property = PropertyParser::parse (propertyData, "folder");

    REQUIRE (property != nullptr);
    CHECK (property->dump ().find ("folder - file") != std::string::npos);
}

TEST_CASE ("Optional JSON fields fall back when workshop data has an incompatible type") {
    const JSON data = {
	{ "padding", "0.00000 0.00000" },
	{ "parent", "not an object id" },
	{ "id", 42 },
    };

    CHECK (data.optional ("padding", 0) == 0);
    CHECK_FALSE (data.optional<int> ("parent").has_value ());
    CHECK (data.optional ("id", -1) == 42);
}
