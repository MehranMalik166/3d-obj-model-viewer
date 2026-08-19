# Large 3D Model Viewer

A web-based 3D viewer for loading large OBJ models using chunk-based loading.

## Project Structure

- `models/` - Contains 3D model files.
- `tool/obj-preprocessor.js` - Preprocesses OBJ models.
- `chunks/` - Contains generated binary chunks.
- `manifest.json` - Contains model and chunk information.
- `model-viewer.html` - Main 3D viewer.

## Model Folder

Each model can have its own folder containing:

- `.obj`
- `.mtl` (optional)
- Texture files (optional)

## Preprocess a Model

Run:

node tool/obj-preprocessor.js <model-folder>

Example:

node tool/obj-preprocessor.js male


## Run Locally

Install dependencies:

npm install

Start the local server:

npx serve . -l 3000

Open in browser:

http://localhost:3000/model-viewer.html


## How It Works

- Reads the OBJ file using streaming.
- Splits the model into smaller chunks.
- Generates binary `.bin` files.
- The viewer loads the required chunks instead of the complete OBJ at once.
- Supports MTL and texture files when available.