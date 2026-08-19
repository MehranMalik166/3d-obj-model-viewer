const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ============================================================
// LARGE OBJ -> BINARY CHUNK PREPROCESSOR
// ============================================================

// ============================================================
// CONFIG
// ============================================================
const modelsDir = path.join(__dirname, "..", "models");
const tempDir = path.join(__dirname, "..", ".obj-temp");

const requestedModel = process.argv[2];

if (!requestedModel) {
  throw new Error(
    "Please provide a model folder name.\n" +
      "Example: node tool/obj-preprocessor.js male",
  );
}

const modelDir = path.join(modelsDir, requestedModel);

if (!fs.existsSync(modelDir)) {
  throw new Error(`Model folder not found: models/${requestedModel}`);
}

const outputDir = path.join(__dirname, "..", "chunks");

const TARGET_CHUNK_MB = 25;

const MIN_GRID_SIZE = 4;
const MAX_GRID_SIZE = 64;

const FACE_BUFFER_BYTES = 4 * 1024 * 1024;

const VERTEX_BLOCK_SIZE = 65536;

const MAX_VERTEX_CACHE_BLOCKS = 64;

const FACE_RECORD_BYTES = 28;

const VERTEX_BYTES = 24;

const UV_BYTES = 8;

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".bmp", ".tga"];

// ============================================================
// PREPARE DIRECTORIES
// ============================================================

fs.mkdirSync(outputDir, { recursive: true });

function removeDirectorySafe(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
    });
  }
}

removeDirectorySafe(tempDir);
fs.mkdirSync(tempDir, { recursive: true });


if (!fs.statSync(modelDir).isDirectory()) {
  throw new Error(
    `Expected a model folder: models/${requestedModel}`,
  );
}

const files = fs.readdirSync(modelDir);

const objFiles = files.filter((file) =>
  file.toLowerCase().endsWith(".obj"),
);

if (objFiles.length === 0) {
  throw new Error(
    `No .obj file found inside models/${requestedModel}/`,
  );
}

if (objFiles.length > 1) {
  console.warn(
    `Multiple OBJ files found. Using: ${objFiles[0]}`,
  );
}

const objFileName = objFiles[0];
const inputFile = path.join(modelDir, objFileName);

console.log(`Model folder: ${requestedModel}`);
console.log(`Using OBJ: ${objFileName}`);

// ============================================================
// FIND MATCHING MTL
// ============================================================

const mtlFiles = files.filter((file) => file.toLowerCase().endsWith(".mtl"));

let mtlFileName = null;

if (mtlFiles.length > 0) {
  const objBaseName = path.basename(objFileName, ".obj").toLowerCase();

  mtlFileName =
    mtlFiles.find(
      (file) => path.basename(file, ".mtl").toLowerCase() === objBaseName,
    ) || null;
}

const mtlFile = mtlFileName ? path.join(modelDir, mtlFileName) : null;

console.log(mtlFile ? `Using MTL: ${mtlFileName}` : "No matching MTL found");

// ============================================================
// STREAM HELPER
// ============================================================

function openLineStream() {
  const stream = fs.createReadStream(inputFile, {
    encoding: "utf8",
    highWaterMark: 8 * 1024 * 1024,
  });

  return readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
}

// ============================================================
// MTL PARSER
// ============================================================

function parseMTL() {
  const materials = [];

  if (!mtlFile || !fs.existsSync(mtlFile)) {
    return materials;
  }

  const text = fs.readFileSync(mtlFile, "utf8");

  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const parts = line.split(/\s+/);
    const command = parts[0];

    if (command === "newmtl") {
      current = {
        name: parts.slice(1).join(" "),
        texture: null,
      };

      materials.push(current);
      continue;
    }

    if (command === "map_Kd" && current) {
      // map_Kd may contain options such as -s/-o/-bm.
      // The common case is simply the texture filename.
      //
      // We take the final token as the actual texture path.
      if (parts.length >= 2) {
        current.texture = parts[parts.length - 1];
      }
    }
  }

  return materials;
}

// ============================================================
// FALLBACK TEXTURE
// ============================================================

function findFallbackTexture() {
  const imageFiles = files.filter((file) =>
    IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase()),
  );

  if (imageFiles.length === 0) {
    return null;
  }

  const objBaseName = path.basename(objFileName, ".obj").toLowerCase();

  const matched = imageFiles.find(
    (file) =>
      path.basename(file, path.extname(file)).toLowerCase() === objBaseName,
  );

  return matched || imageFiles[0];
}

// ============================================================
// PASS 0
// COUNT VERTICES + UVS
// ============================================================

async function countVerticesAndUVs() {
  console.log("");
  console.log("=================================");
  console.log("PASS 0");
  console.log("Counting vertices / UVs...");
  console.log("=================================");

  let vertexCount = 0;
  let uvCount = 0;

  for await (const line of openLineStream()) {
    if (line.startsWith("v ")) {
      const parts = line.trim().split(/\s+/);

      if (parts.length < 4) {
        continue;
      }

      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);

      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        vertexCount++;
      }

      continue;
    }

    if (line.startsWith("vt ")) {
      const parts = line.trim().split(/\s+/);

      if (parts.length < 3) {
        continue;
      }

      const u = Number(parts[1]);
      const v = Number(parts[2]);

      if (Number.isFinite(u) && Number.isFinite(v)) {
        uvCount++;
      }
    }
  }

  console.log(`Vertices: ${vertexCount.toLocaleString()}`);

  console.log(`UV coordinates: ${uvCount.toLocaleString()}`);

  return {
    vertexCount,
    uvCount,
  };
}

// ============================================================
// PASS 1
// WRITE VERTICES + UVS TO TEMP BINARY
// ============================================================

async function writeVertexData(vertexCount, uvCount) {
  console.log("");
  console.log("=================================");
  console.log("PASS 1");
  console.log("Writing vertex / UV binary data...");
  console.log("=================================");

  const vertexFile = path.join(tempDir, "vertices.bin");

  const uvFile = path.join(tempDir, "uvs.bin");

  const vertexFd = fs.openSync(vertexFile, "w");

  const uvFd = fs.openSync(uvFile, "w");

  const vertexBuffer = Buffer.allocUnsafe(VERTEX_BYTES);

  const uvBuffer = Buffer.allocUnsafe(UV_BYTES);

  let vertexIndex = 0;
  let uvIndex = 0;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;

  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  try {
    for await (const line of openLineStream()) {
      if (line.startsWith("v ")) {
        const parts = line.trim().split(/\s+/);

        if (parts.length < 4) {
          continue;
        }

        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const z = Number(parts[3]);

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          continue;
        }

        const offset = vertexIndex * VERTEX_BYTES;

        vertexBuffer.writeDoubleLE(x, 0);
        vertexBuffer.writeDoubleLE(y, 8);
        vertexBuffer.writeDoubleLE(z, 16);

        fs.writeSync(vertexFd, vertexBuffer, 0, VERTEX_BYTES, offset);

        vertexIndex++;

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);

        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);

        continue;
      }

      if (line.startsWith("vt ")) {
        const parts = line.trim().split(/\s+/);

        if (parts.length < 3) {
          continue;
        }

        const u = Number(parts[1]);
        const v = Number(parts[2]);

        if (!Number.isFinite(u) || !Number.isFinite(v)) {
          continue;
        }

        const offset = uvIndex * UV_BYTES;

        uvBuffer.writeFloatLE(u, 0);
        uvBuffer.writeFloatLE(v, 4);

        fs.writeSync(uvFd, uvBuffer, 0, UV_BYTES, offset);

        uvIndex++;
      }
    }
  } finally {
    fs.closeSync(vertexFd);
    fs.closeSync(uvFd);
  }

  if (vertexIndex !== vertexCount) {
    throw new Error(
      `Vertex count mismatch. Expected ${vertexCount}, got ${vertexIndex}`,
    );
  }

  if (uvIndex !== uvCount) {
    throw new Error(`UV count mismatch. Expected ${uvCount}, got ${uvIndex}`);
  }

  const bounds = {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
  };

  console.log("Bounds:", bounds);

  return {
    vertexFile,
    uvFile,
    bounds,
  };
}

// ============================================================
// DYNAMIC GRID
// ============================================================

function computeGridSize(inputFileBytes) {
  const fileMB = inputFileBytes / (1024 * 1024);

  const idealChunks = Math.ceil(fileMB / TARGET_CHUNK_MB);

  let gridSize = Math.ceil(Math.sqrt(idealChunks));

  gridSize = Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, gridSize));

  console.log("");
  console.log(`Input size: ${fileMB.toFixed(1)} MB`);

  console.log(`Spatial grid: ${gridSize}x${gridSize}`);

  console.log(`Maximum cells: ${gridSize * gridSize}`);

  return gridSize;
}

// ============================================================
// VERTEX READER WITH LRU BLOCK CACHE
// ============================================================

class VertexReader {
  constructor(vertexFile, uvFile) {
    this.vertexFd = fs.openSync(vertexFile, "r");

    this.uvFd = fs.openSync(uvFile, "r");

    this.vertexCache = new Map();
    this.uvCache = new Map();
  }

  readVertex(index) {
    const blockId = Math.floor(index / VERTEX_BLOCK_SIZE);

    let block = this.vertexCache.get(blockId);

    if (!block) {
      const count = VERTEX_BLOCK_SIZE;

      const buffer = Buffer.allocUnsafe(count * VERTEX_BYTES);

      const position = blockId * VERTEX_BLOCK_SIZE * VERTEX_BYTES;

      const bytesRead = fs.readSync(
        this.vertexFd,
        buffer,
        0,
        buffer.length,
        position,
      );

      block = {
        buffer,
        bytesRead,
      };

      this.vertexCache.delete(blockId);
      this.vertexCache.set(blockId, block);

      while (this.vertexCache.size > MAX_VERTEX_CACHE_BLOCKS) {
        const first = this.vertexCache.keys().next().value;

        this.vertexCache.delete(first);
      }
    } else {
      this.vertexCache.delete(blockId);
      this.vertexCache.set(blockId, block);
    }

    const local = index % VERTEX_BLOCK_SIZE;

    const offset = local * VERTEX_BYTES;

    if (offset + VERTEX_BYTES > block.bytesRead) {
      throw new Error(`Vertex index ${index} is outside vertex file`);
    }

    return [
      block.buffer.readDoubleLE(offset),
      block.buffer.readDoubleLE(offset + 8),
      block.buffer.readDoubleLE(offset + 16),
    ];
  }

  readUV(index) {
    const blockSize = 131072;

    const blockId = Math.floor(index / blockSize);

    let block = this.uvCache.get(blockId);

    if (!block) {
      const bytes = blockSize * UV_BYTES;

      const buffer = Buffer.allocUnsafe(bytes);

      const position = blockId * blockSize * UV_BYTES;

      const bytesRead = fs.readSync(this.uvFd, buffer, 0, bytes, position);

      block = {
        buffer,
        bytesRead,
      };

      this.uvCache.delete(blockId);
      this.uvCache.set(blockId, block);

      while (this.uvCache.size > 32) {
        const first = this.uvCache.keys().next().value;

        this.uvCache.delete(first);
      }
    } else {
      this.uvCache.delete(blockId);
      this.uvCache.set(blockId, block);
    }

    const local = index % blockSize;

    const offset = local * UV_BYTES;

    if (offset + UV_BYTES > block.bytesRead) {
      throw new Error(`UV index ${index} is outside UV file`);
    }

    return [
      block.buffer.readFloatLE(offset),
      block.buffer.readFloatLE(offset + 4),
    ];
  }

  close() {
    fs.closeSync(this.vertexFd);
    fs.closeSync(this.uvFd);
  }
}

// ============================================================
// FACE TOKEN
// ============================================================

function parseFaceToken(token, vertexCount, uvCount) {
  const parts = token.split("/");

  let vertexIndex = Number(parts[0]);

  let uvIndex = parts.length > 1 && parts[1] !== "" ? Number(parts[1]) : -1;

  if (!Number.isInteger(vertexIndex)) {
    return null;
  }

  if (vertexIndex < 0) {
    vertexIndex = vertexCount + vertexIndex;
  } else {
    vertexIndex--;
  }

  if (vertexIndex < 0 || vertexIndex >= vertexCount) {
    return null;
  }

  if (uvIndex < 0) {
    uvIndex = uvCount + uvIndex;
  } else if (uvIndex > 0) {
    uvIndex--;
  } else {
    uvIndex = -1;
  }

  if (uvIndex < -1 || uvIndex >= uvCount) {
    uvIndex = -1;
  }

  return {
    vertexIndex,
    uvIndex,
  };
}

// ============================================================
// CHUNK ID
// ============================================================

function getChunkId(vertexReader, a, b, c, bounds, gridSize) {
  const va = vertexReader.readVertex(a);

  const vb = vertexReader.readVertex(b);

  const vc = vertexReader.readVertex(c);

  const centerX = (va[0] + vb[0] + vc[0]) / 3;

  const centerZ = (va[2] + vb[2] + vc[2]) / 3;

  const width = bounds.maxX - bounds.minX;

  const depth = bounds.maxZ - bounds.minZ;

  let gridX = 0;
  let gridZ = 0;

  if (width > 0) {
    gridX = Math.floor(((centerX - bounds.minX) / width) * gridSize);
  }

  if (depth > 0) {
    gridZ = Math.floor(((centerZ - bounds.minZ) / depth) * gridSize);
  }

  gridX = Math.max(0, Math.min(gridSize - 1, gridX));

  gridZ = Math.max(0, Math.min(gridSize - 1, gridZ));

  return `${gridX}_${gridZ}`;
}

// ============================================================
// TEMP FACE WRITER
// ============================================================

class FaceFileManager {
  constructor() {
    this.files = new Map();
    this.buffers = new Map();
  }

  getFile(chunkId) {
    let file = this.files.get(chunkId);

    if (!file) {
      const filename = `faces_${chunkId}.bin`;

      const filepath = path.join(tempDir, filename);

      file = fs.createWriteStream(filepath, {
        flags: "a",
        highWaterMark: FACE_BUFFER_BYTES,
      });

      this.files.set(chunkId, file);

      this.buffers.set(chunkId, []);
    }

    return file;
  }

  write(chunkId, a, ua, b, ub, c, uc, materialId) {
    const file = this.getFile(chunkId);

    const buffer = Buffer.allocUnsafe(FACE_RECORD_BYTES);

    buffer.writeUInt32LE(a, 0);
    buffer.writeUInt32LE(ua + 1, 4);

    buffer.writeUInt32LE(b, 8);
    buffer.writeUInt32LE(ub + 1, 12);

    buffer.writeUInt32LE(c, 16);
    buffer.writeUInt32LE(uc + 1, 20);

    buffer.writeUInt32LE(materialId, 24);

    // write() internally buffers the data.
    // Return false is intentionally ignored because
    // the OBJ parser should not keep the whole file in RAM.
    file.write(buffer);
  }

  async close() {
    await Promise.all(
      [...this.files.values()].map(
        (stream) =>
          new Promise((resolve, reject) => {
            stream.once("finish", resolve);

            stream.once("error", reject);

            stream.end();
          }),
      ),
    );
  }

  getChunkIds() {
    return [...this.files.keys()];
  }
}

// ============================================================
// PASS 2
// STREAM FACES -> TEMPORARY SPATIAL FILES
// ============================================================

async function createTemporaryFaceChunks(
  vertexReader,
  vertexCount,
  uvCount,
  bounds,
  gridSize,
  materials,
) {
  console.log("");
  console.log("=================================");
  console.log("PASS 2");
  console.log("Streaming faces into spatial files...");
  console.log("=================================");

  const materialIds = new Map();

  materials.forEach((material, index) => {
    materialIds.set(material.name, index);
  });

  const manager = new FaceFileManager();

  let currentMaterial = null;
  let totalFaces = 0;

  try {
    for await (const line of openLineStream()) {
      if (line.startsWith("usemtl ")) {
        currentMaterial = line.substring(7).trim();

        continue;
      }

      if (!line.startsWith("f ")) {
        continue;
      }

      const parts = line.substring(2).trim().split(/\s+/);

      if (parts.length < 3) {
        continue;
      }

      const faceVertices = parts
        .map((token) => parseFaceToken(token, vertexCount, uvCount))
        .filter(Boolean);

      if (faceVertices.length < 3) {
        continue;
      }

      const materialId = materialIds.has(currentMaterial)
        ? materialIds.get(currentMaterial)
        : 0;

      // Fan triangulation.
      for (let i = 1; i < faceVertices.length - 1; i++) {
        const a = faceVertices[0];

        const b = faceVertices[i];

        const c = faceVertices[i + 1];

        const chunkId = getChunkId(
          vertexReader,
          a.vertexIndex,
          b.vertexIndex,
          c.vertexIndex,
          bounds,
          gridSize,
        );

        manager.write(
          chunkId,
          a.vertexIndex,
          a.uvIndex,
          b.vertexIndex,
          b.uvIndex,
          c.vertexIndex,
          c.uvIndex,
          materialId,
        );

        totalFaces++;
      }
    }

    await manager.close();
  } catch (error) {
    // Make sure streams are closed if parsing fails.
    try {
      await manager.close();
    } catch {}

    throw error;
  }

  console.log(`Total faces: ${totalFaces.toLocaleString()}`);

  console.log(`Spatial chunks: ${manager.getChunkIds().length}`);

  return {
    chunkIds: manager.getChunkIds(),
    totalFaces,
  };
}

// ============================================================
// READ TEMP FACE CHUNK
// ============================================================

function readFaceRecords(filepath) {
  const stats = fs.statSync(filepath);

  if (stats.size % FACE_RECORD_BYTES !== 0) {
    throw new Error(`Corrupt temporary face file: ${filepath}`);
  }

  const buffer = fs.readFileSync(filepath);

  const records = [];

  for (let offset = 0; offset < buffer.length; offset += FACE_RECORD_BYTES) {
    records.push({
      a: buffer.readUInt32LE(offset),

      ua: buffer.readUInt32LE(offset + 4) - 1,

      b: buffer.readUInt32LE(offset + 8),

      ub: buffer.readUInt32LE(offset + 12) - 1,

      c: buffer.readUInt32LE(offset + 16),

      uc: buffer.readUInt32LE(offset + 20) - 1,

      materialId: buffer.readUInt32LE(offset + 24),
    });
  }

  return records;
}

// ============================================================
// BUILD FINAL CHUNK
// ============================================================

function buildFinalChunk(chunkId, faceFile, vertexReader, materials) {
  console.log(`Building chunk ${chunkId}...`);

  const faces = readFaceRecords(faceFile);

  const vertexMap = new Map();

  const positions = [];
  const uvs = [];
  const indices = [];
  const materialIds = [];

  const usedMaterials = new Set();

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;

  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  function getLocalVertex(vertexIndex, uvIndex) {
    const key = `${vertexIndex}/${uvIndex}`;

    const existing = vertexMap.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const localIndex = positions.length / 3;

    const vertex = vertexReader.readVertex(vertexIndex);

    positions.push(vertex[0], vertex[1], vertex[2]);

    if (uvIndex >= 0) {
      const uv = vertexReader.readUV(uvIndex);

      uvs.push(uv[0], uv[1]);
    } else {
      uvs.push(0, 0);
    }

    minX = Math.min(minX, vertex[0]);

    minY = Math.min(minY, vertex[1]);

    minZ = Math.min(minZ, vertex[2]);

    maxX = Math.max(maxX, vertex[0]);

    maxY = Math.max(maxY, vertex[1]);

    maxZ = Math.max(maxZ, vertex[2]);

    vertexMap.set(key, localIndex);

    return localIndex;
  }

  for (const face of faces) {
    const a = getLocalVertex(face.a, face.ua);

    const b = getLocalVertex(face.b, face.ub);

    const c = getLocalVertex(face.c, face.uc);

    indices.push(a, b, c);

    materialIds.push(face.materialId);

    if (materials[face.materialId]) {
      usedMaterials.add(materials[face.materialId].name);
    }
  }

  const positionArray = new Float32Array(positions);

  const uvArray = new Float32Array(uvs);

  const indexArray = new Uint32Array(indices);

  const materialArray = new Uint32Array(materialIds);

  const header = Buffer.alloc(16);

  header.writeUInt32LE(positionArray.length / 3, 0);

  header.writeUInt32LE(indexArray.length, 4);

  header.writeUInt32LE(uvArray.length / 2, 8);

  header.writeUInt32LE(materialArray.length, 12);

  const binary = Buffer.concat([
    header,

    Buffer.from(positionArray.buffer),

    Buffer.from(uvArray.buffer),

    Buffer.from(indexArray.buffer),

    Buffer.from(materialArray.buffer),
  ]);

  const filename = `chunk_${chunkId}.bin`;

  const outputFile = path.join(outputDir, filename);

  fs.writeFileSync(outputFile, binary);

  return {
    id: chunkId,
    file: filename,

    vertices: positionArray.length / 3,

    indices: indexArray.length,

    faces: materialArray.length,

    uvs: uvArray.length / 2,

    materials: [...usedMaterials],

    size: binary.length,

    center: {
      x: (minX + maxX) / 2,

      y: (minY + maxY) / 2,

      z: (minZ + maxZ) / 2,
    },

    bounds: {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
    },
  };
}

// ============================================================
// PASS 3
// ONE CHUNK AT A TIME
// ============================================================

function writeFinalChunks(chunkIds, vertexReader, materials) {
  console.log("");
  console.log("=================================");
  console.log("PASS 3");
  console.log("Building final binary chunks...");
  console.log("=================================");

  const manifestChunks = [];

  for (const chunkId of chunkIds) {
    const faceFile = path.join(tempDir, `faces_${chunkId}.bin`);

    if (!fs.existsSync(faceFile)) {
      continue;
    }

    const chunk = buildFinalChunk(chunkId, faceFile, vertexReader, materials);

    manifestChunks.push(chunk);

    console.log(
      `Created ${chunk.file} ` +
        `(${(chunk.size / 1024 / 1024).toFixed(2)} MB)`,
    );
  }

  return manifestChunks;
}

// ============================================================
// CLEAN OLD OUTPUT
// ============================================================

function cleanOutputDirectory() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });

    return;
  }

  for (const file of fs.readdirSync(outputDir)) {
    const fullPath = path.join(outputDir, file);

    if (file.endsWith(".bin") || file === "manifest.json") {
      fs.rmSync(fullPath, {
        force: true,
      });
    }
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const startedAt = Date.now();

  console.log("");
  console.log("=================================");
  console.log("LARGE OBJ PREPROCESSOR");
  console.log("=================================");
  console.log(`Model: ${objFileName}`);

  const inputStats = fs.statSync(inputFile);

  console.log(`Input: ${(inputStats.size / 1024 / 1024 / 1024).toFixed(2)} GB`);

  cleanOutputDirectory();

  // ----------------------------------------------------------
  // MATERIALS
  // ----------------------------------------------------------

  let materials = parseMTL();

  console.log(`Materials found: ${materials.length}`);

  if (materials.length === 0) {
    const fallbackTexture = findFallbackTexture();

    if (fallbackTexture) {
      console.log(`Using fallback texture: ${fallbackTexture}`);

      materials = [
        {
          name: "default",
          texture: fallbackTexture,
        },
      ];
    } else {
      console.log("No MTL / texture. Using plain material.");
    }
  }

  materials.forEach((material, index) => {
    console.log(
      `[${index}] ${material.name}` +
        (material.texture ? ` -> ${material.texture}` : ""),
    );
  });

  // ----------------------------------------------------------
  // GRID
  // ----------------------------------------------------------

  const gridSize = computeGridSize(inputStats.size);

  // ----------------------------------------------------------
  // PASS 0
  // ----------------------------------------------------------

  const { vertexCount, uvCount } = await countVerticesAndUVs();

  // ----------------------------------------------------------
  // PASS 1
  // ----------------------------------------------------------

  const { vertexFile, uvFile, bounds } = await writeVertexData(
    vertexCount,
    uvCount,
  );

  // ----------------------------------------------------------
  // RANDOM ACCESS READER
  // ----------------------------------------------------------

  const vertexReader = new VertexReader(vertexFile, uvFile);

  try {
    // --------------------------------------------------------
    // PASS 2
    // --------------------------------------------------------

    const { chunkIds, totalFaces } = await createTemporaryFaceChunks(
      vertexReader,
      vertexCount,
      uvCount,
      bounds,
      gridSize,
      materials,
    );

    // --------------------------------------------------------
    // PASS 3
    // --------------------------------------------------------

    const manifestChunks = writeFinalChunks(chunkIds, vertexReader, materials);

    manifestChunks.sort((a, b) =>
      a.id.localeCompare(b.id, undefined, {
        numeric: true,
      }),
    );

    // --------------------------------------------------------
    // MANIFEST
    // --------------------------------------------------------

    const manifest = {
      source: path.basename(inputFile),
      modelFolder: requestedModel,

      materialFile: mtlFile ? path.basename(mtlFile) : null,

      format: "binary-mesh-textured",

      version: 3,

      gridSize,

      totalVertices: vertexCount,

      totalUVs: uvCount,

      totalFaces,

      bounds,

      materials,

      chunks: manifestChunks,
    };

    fs.writeFileSync(
      path.join(outputDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log("");
    console.log("=================================");
    console.log("PREPROCESSING COMPLETE");
    console.log("=================================");
    console.log(`Model: ${objFileName}`);
    console.log(`Grid: ${gridSize}x${gridSize}`);
    console.log(`Chunks: ${manifestChunks.length}`);
    console.log(`Vertices: ${vertexCount.toLocaleString()}`);
    console.log(`UVs: ${uvCount.toLocaleString()}`);
    console.log(`Faces: ${totalFaces.toLocaleString()}`);
    console.log(`Time: ${elapsed}s`);
    console.log(`Output: ${outputDir}`);
    console.log("=================================");
  } finally {
    vertexReader.close();
  }

  // ----------------------------------------------------------
  // REMOVE TEMPORARY DATA
  // ----------------------------------------------------------

  console.log("Cleaning temporary files...");

  removeDirectorySafe(tempDir);

  console.log("Temporary files removed.");
}

main().catch((error) => {
  console.error("");
  console.error("=================================");
  console.error("PREPROCESSING FAILED");
  console.error("=================================");
  console.error(error);
  console.error("=================================");

  // Keep temp directory on failure.
  // This is intentional so the failed run can be inspected.
  process.exit(1);
});
