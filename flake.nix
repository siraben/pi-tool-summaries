{
  description = "Development environment for plain-language Pi tool summaries";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShellNoCC {
            packages = [ pkgs.nodejs_22 pkgs.git pkgs.ripgrep ];
            shellHook = ''
              echo "Pi summaries: npx --yes npm@12.2.0 ci, then npm run check && npm test"
              echo "Use npm exec -- pi -e ./src/index.ts for the pinned Pi version."
            '';
          };
        });
    };
}
