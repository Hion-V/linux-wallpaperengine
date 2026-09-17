{
  description = "Wallpaper Engine for Linux with a GNOME 50 desktop bridge";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    glslang-WallpaperEngine = { url = "github:Almamu/glslang-WallpaperEngine/b775500a153f5ceb0e4b6f366b79c4c57521bb62"; flake = false; };
    SPIRV-Cross-WallpaperEngine = { url = "github:Almamu/SPIRV-Cross-WallpaperEngine/ad4d02220b01c1800e5a4e6671d6d8ca8ab07783"; flake = false; };
    stb = { url = "github:nothings/stb/f0569113c93ad095470c54bf34a17b36646bbbb5"; flake = false; };
    json = { url = "github:nlohmann/json/4424a0fcc1c7fa640b5c87d26776d99150dacd10"; flake = false; };
    MimeTypes = { url = "github:lasselukkari/MimeTypes/8990d6a796bd9904ec3d41e5c150a1ffb48fe32e"; flake = false; };
    kissfft = { url = "github:mborgerding/kissfft/febd4caeed32e33ad8b2e0bb5ea77542c40f18ec"; flake = false; };
    argparse = { url = "github:p-ranav/argparse/d924b84eba1f0f0adf38b20b7b4829f6f65b6570"; flake = false; };
    Catch2 = { url = "github:catchorg/Catch2/b3fb4b9feafcd8d91c5cb510a4775143fdbef02f"; flake = false; };
    quickjs = { url = "github:quickjs-ng/quickjs/72ba50f63ee31202f8c18b8d07ab1e1c3486ee6f"; flake = false; };
  };
  outputs = inputs@{ self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          engine = pkgs.linux-wallpaperengine.overrideAttrs (old: {
            version = "0.0.1-gnome-bridge";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [ ./CMakeLists.txt ./CMakeModules ./src ./protocols ];
            };
            postUnpack = (old.postUnpack or "") + ''
              cd "$sourceRoot"
              mkdir -p src/External/glslang-WallpaperEngine
              cp -r ${inputs.glslang-WallpaperEngine}/. src/External/glslang-WallpaperEngine/
              mkdir -p src/External/SPIRV-Cross-WallpaperEngine
              cp -r ${inputs.SPIRV-Cross-WallpaperEngine}/. src/External/SPIRV-Cross-WallpaperEngine/
              mkdir -p src/External/stb
              cp -r ${inputs.stb}/. src/External/stb/
              mkdir -p src/External/json
              cp -r ${inputs.json}/. src/External/json/
              mkdir -p src/External/MimeTypes
              cp -r ${inputs.MimeTypes}/. src/External/MimeTypes/
              mkdir -p src/External/kissfft
              cp -r ${inputs.kissfft}/. src/External/kissfft/
              mkdir -p src/External/argparse
              cp -r ${inputs.argparse}/. src/External/argparse/
              mkdir -p src/External/Catch2
              cp -r ${inputs.Catch2}/. src/External/Catch2/
              mkdir -p src/External/quickjs
              cp -r ${inputs.quickjs}/. src/External/quickjs/
              chmod -R u+w src/External
              cd ..
            '';
          });
          extension = pkgs.stdenvNoCC.mkDerivation {
            pname = "gnome-shell-extension-linux-wallpaperengine";
            version = "3";
            src = ./gnome-extension;
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/share/gnome-shell/extensions/linux-wallpaperengine@almamu.github.io
              cp extension.js overview.js blurMyShell.js metadata.json $out/share/gnome-shell/extensions/linux-wallpaperengine@almamu.github.io/
            '';
            passthru.extensionUuid = "linux-wallpaperengine@almamu.github.io";
            meta = { platforms = systems; license = pkgs.lib.licenses.gpl3Plus; };
          };
        in { default = engine; linux-wallpaperengine = engine; gnome-extension = extension; });
      apps = eachSystem (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/linux-wallpaperengine";
          meta.description = "Run Linux Wallpaper Engine";
        };
      });
      checks = eachSystem (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          bridge = pkgs.runCommand "gnome-bridge-tests" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
            cp -r ${./gnome-extension} gnome-extension
            mkdir tests
            cp ${./tests/gnome-bridge.mjs} tests/gnome-bridge.mjs
            cp ${./tests/gnome-overview.mjs} tests/gnome-overview.mjs
            cp ${./tests/gnome-blur-my-shell.mjs} tests/gnome-blur-my-shell.mjs
            node tests/gnome-bridge.mjs
            node tests/gnome-overview.mjs
            node tests/gnome-blur-my-shell.mjs
            touch $out
          '';
          extension = self.packages.${system}.gnome-extension;
        });
      devShells = eachSystem (system:
        let pkgs = import nixpkgs { inherit system; };
        in { default = pkgs.mkShell { inputsFrom = [ self.packages.${system}.default ]; }; });
      nixosModules.default = { pkgs, lib, config, ... }:
        let cfg = config.programs.linux-wallpaperengine;
        in {
          options.programs.linux-wallpaperengine.enable = lib.mkEnableOption "Wallpaper Engine and its GNOME Shell bridge";
          config = lib.mkIf cfg.enable {
            environment.systemPackages = with self.packages.${pkgs.stdenv.hostPlatform.system}; [ linux-wallpaperengine gnome-extension ];
          };
        };
    };
}
