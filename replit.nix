
{ pkgs }: {
    deps = [
        pkgs.nodejs
        pkgs.nodePackages.typescript
        pkgs.nodePackages.typescript-language-server
        # Puppeteer dependencies
        pkgs.chromium
        pkgs.libxcb
        pkgs.xorg.libX11
        pkgs.xorg.libXcomposite
        pkgs.xorg.libXcursor
        pkgs.xorg.libXdamage
        pkgs.xorg.libXext
        pkgs.xorg.libXfixes
        pkgs.xorg.libXi
        pkgs.xorg.libXrender
        pkgs.xorg.libXtst
        pkgs.xorg.libxcb
        pkgs.xorg.libxshmfence
        pkgs.nss
        pkgs.nspr
    ];
}
