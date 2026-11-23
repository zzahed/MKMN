# MKMN: words and common questions

## Words used in MKMN

- **NPU** (neural processing unit): the part of a Snapdragon X chip built for AI work; MKMN runs local models on it (the Qualcomm Hexagon NPU) so they are fast and use little power.
- **GenieX**: Qualcomm's runtime that loads a model and runs it on the NPU, CPU or GPU; MKMN needs version 0.11.0 or newer and asks before it downloads it.
- **QAIRT** (Qualcomm AI Runtime): the Qualcomm libraries GenieX uses to run a model built for the NPU; a model built for one QAIRT version may not load on another.
- **FUSE** (HUMAIN FUSE): HUMAIN's cloud model platform; with your own HUMAIN API key, a chat can run there instead of on your PC.
- **Node** (HUMAIN Node): HUMAIN's hosted AI services, a second cloud choice with its own models and APIs, also used with your own key.

## Common questions

### Is it free?

Yes. MKMN is free and open source under the [MIT license](../../LICENSE), and
local chat costs nothing to run. GenieX and the models are separate downloads
that keep their own licenses. The HUMAIN cloud choices (FUSE and Node) use your own
HUMAIN API key, and HUMAIN sets what that costs.

### Does it work offline?

Yes, for local chat. You need the internet once, to download GenieX and a
model. After that, chat and work with your files run on the PC with no
connection. A chat on HUMAIN FUSE or Node, a model download and the web
features need the internet, and MKMN says so when they do.

### The model won't load. What now?

1. Open **Settings → Developer → Requirements**. It shows whether GenieX is
   installed and new enough (0.11.0 or newer), the NPU driver, and whether a
   chat model is installed.
2. If GenieX is missing or too old, install it from the setup screen.
3. On the error, expand **Raw message**. It shows the model build, the GenieX
   and QAIRT versions and the runtime's own lines. Click **Try again** once.
4. Try a smaller model, or the same model built for another engine (NPU,
   Hybrid or CPU) in **Settings → Models**.
5. Still stuck? Click **Copy full log** and
   [open a bug report](https://github.com/zzahed/MKMN/issues/new/choose) with it.
   Check the log first and remove anything private.

More detail: "GenieX model-load errors" and "QAIRT context format" in the
[user guide](user-guide.md#other-app-features).

### Is my data private?

With local chat, your chats, files and models stay on your PC; no remote
server is needed. If you choose HUMAIN FUSE or Node for a chat, that chat's
messages and attached content are sent to HUMAIN, under HUMAIN's terms. API
keys are kept on your PC, protected by your Windows account.
[What is stored on your PC](../design/data-at-rest.md) lists every file MKMN
keeps, where it is and when it is removed. To report a security problem, see
[SECURITY.md](../../SECURITY.md).

### Which PCs does it run on?

Snapdragon X laptops (ARM64) with Windows 11, build 22000 or newer. The
reference machine is a Snapdragon X2 Elite; MKMN also runs on other
Snapdragon X laptops and measures each model's speed on your own PC. The
installer is built for ARM64 only, so it is not for Intel or AMD PCs. To work on the interface without one, see
"UI work without a Snapdragon laptop" in [CONTRIBUTING.md](../../CONTRIBUTING.md).
