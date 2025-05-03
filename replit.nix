
{ pkgs }: {
    deps = [
        pkgs.nodejs-18_x
        pkgs.nodePackages.typescript-language-server
        # System dependencies
        pkgs.nodejs
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
        pkgs.xorg.libxshmfence
        pkgs.nss
        pkgs.nspr
        pkgs.atk
        pkgs.at-spi2-atk
        pkgs.dbus
        pkgs.cups
        pkgs.gtk3
        pkgs.pango
        pkgs.cairo
        pkgs.gdk-pixbuf
    ];
}
