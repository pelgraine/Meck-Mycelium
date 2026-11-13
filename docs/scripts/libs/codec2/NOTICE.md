# Codec 2 WebAssembly builds

`c2enc.js`, `c2enc.wasm`, `c2dec.js` and `c2dec.wasm` are unmodified build
outputs from rameshvarun/codec2-emscripten (https://github.com/rameshvarun/codec2-emscripten,
commit 68e323e, 27 Apr 2023). They are compiled from Codec 2
(https://github.com/drowe67/codec2, commit 67f31bce) and are licensed under the
GNU Lesser General Public License, version 2.1.

Meck-Mycelium loads them as separate files at run time and uses Codec 2 mode
1200, the mode used by Meck, Meck-P4 and Meck Watch voice notes.
