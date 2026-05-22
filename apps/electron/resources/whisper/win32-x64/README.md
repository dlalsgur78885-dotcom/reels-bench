# whisper.cpp — vendored Windows x64 binary

This folder holds the bundled whisper.cpp CLI used by the auto-caption STT
feature. The files here are committed to the repo (small — ~4.5 MB total) and
copied verbatim into the packaged app via `electron-builder.json` →
`extraResources` (`whisper/win32-x64`).

## Currently vendored

Pinned release: **whisper.cpp v1.8.4**
Source asset: `whisper-bin-x64.zip`
<https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.4>

| File             | Required | SHA-256                                                            |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `whisper-cli.exe`| yes      | `d4c598cf97de103f888d1a53b8abddc85bf27ab752f785ca69318cedc8a2cf64` |
| `whisper.dll`    | yes      | `ce1958796ebd9d03aafc56cdc2f04c21f214a9c7623889a0a23bc6c162976e87` |
| `ggml.dll`       | yes      | `9f2b124cbe1d002dc25de9a5ff9813c4fec7ef9f3bb9f41035fc6b46fb77bfa0` |
| `ggml-base.dll`  | yes      | `138a2b1a03b7dd757d764f60b39a8b32a08137e21fce4d3d78fbac6c5e716f9d` |
| `ggml-cpu.dll`   | yes      | `9a74d977527dbac38d96900fd7ce422aebbf96001aff5be6a05d7c547dcb9bcb` |
| `SDL2.dll`       | no*      | `de23db1694a3c7a4a735e7ecd3d214b2023cc2267922c6c35d30c7fc7370d677` |

`whisper-cli.exe` dynamically loads `whisper.dll` + `ggml*.dll` from this same
folder, so all five `.dll`s must sit beside the `.exe`. `SDL2.dll` is only used
by the streaming tools (not `whisper-cli`); it is kept for completeness but can
be deleted to shave 2.4 MB.

The bench / stream / talk-llama / server / vad tools from the upstream zip are
**not** vendored — only the CLI + its runtime DLLs.

## Re-vendoring manually (offline build / version bump)

If `resolveWhisperPath()` throws `binary_missing`, this folder is empty. To fix:

1. Download `whisper-bin-x64.zip` from the whisper.cpp releases page above
   (or a newer release that still publishes that asset).
2. Unzip it. The binaries are inside a `Release/` subfolder.
3. Copy `whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, and
   `ggml-cpu.dll` into **this** folder (`apps/electron/resources/whisper/win32-x64/`).
4. Update the pinned version + SHA-256 table in `src/main/stt/binary.ts`
   (header comment) and in this README.

## Model

The GGML model (`ggml-base.bin`, ~148 MB) is **not** vendored. It is downloaded
on first transcription into `%APPDATA%/Reels Studio/models/` and checksum-
verified. See `MODEL_REGISTRY` in `src/main/stt/binary.ts`:

- URL: <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin>
- SHA-256: `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`
- Size: 147,951,465 bytes
