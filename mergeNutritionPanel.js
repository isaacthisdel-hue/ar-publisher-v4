const { Document, NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { renderTextToPNG } = require('./renderText');

// Merges a flat, unlit "nutrition card" plane into an existing GLB buffer.
// The plane sits flat on the ground, next to the model's bounding box.
//
// nutrition = { calories, protein, carbs, fat, allergens }
// Returns a Buffer containing the new merged GLB.
async function mergeNutritionPanel(glbBuffer, nutrition) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

  const document = await io.readBinary(new Uint8Array(glbBuffer));
  const root = document.getRoot();

  // ── 1. Compute a simple bounding box from all existing POSITION accessors ──
  // Assumes the model's root nodes have no major offset/rotation — true for
  // typical Polycam/Blender exports used in this pipeline.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const arr = pos.getArray();
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
  }

  // Fallback if no geometry found (shouldn't happen with a real model)
  if (!isFinite(minX)) { minX = -0.1; maxX = 0.1; minY = 0; maxY = 0.1; minZ = -0.1; maxZ = 0.1; }

  const modelWidth = maxX - minX;
  const groundY = minY; // place the panel flat on the model's lowest point

  // ── 2. Build the nutrition text lines ──
  const lines = [];
  if (nutrition.calories) lines.push(`${nutrition.calories} KCAL`);
  const macros = [];
  if (nutrition.protein) macros.push(`${nutrition.protein}G PROTEIN`);
  if (nutrition.carbs)   macros.push(`${nutrition.carbs}G CARBS`);
  if (nutrition.fat)     macros.push(`${nutrition.fat}G FAT`);
  if (macros.length) lines.push(macros.join(' / '));
  if (nutrition.allergens) lines.push(`CONTAINS: ${nutrition.allergens}`);
  if (lines.length === 0) return glbBuffer; // nothing to add

  const { buffer: pngBuffer, width: pxW, height: pxH } = renderTextToPNG(lines);

  // ── 3. Create the texture + unlit material ──
  const texture = document.createTexture('nutrition-label')
    .setImage(pngBuffer)
    .setMimeType('image/png');

  // Standard PBR material (NOT unlit): Three.js's USDZExporter silently skips
  // any mesh whose material isn't MeshStandardMaterial, so unlit would make
  // the panel vanish from every USDZ conversion.
  const material = document.createMaterial('nutrition-label-material')
    .setBaseColorTexture(texture)
    .setRoughnessFactor(1.0)
    .setMetallicFactor(0.0)
    .setAlphaMode('OPAQUE');

  // ── 4. Build a flat plane, oriented to match how the dish actually sits ──
  const aspect = pxW / pxH;

  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;

  // The thinnest axis is the "up" direction (the table surface normal).
  // We float a small vertical label above the plate along that axis, standing
  // upright and facing the diner — like an Apple Vision Pro floating label.
  const minSize = Math.min(sizeX, sizeY, sizeZ);
  const dishFootprint = Math.max(sizeX, sizeY, sizeZ); // widest dimension = plate diameter

  // Panel size: small — about 45% of the plate's width, so it reads as a label
  const planeW = dishFootprint * 0.90;
  const planeH = planeW / aspect;
  const halfW = planeW / 2;

  let positionsFlat, normals;

  if (minSize === sizeY) {
    // Up = Y (dish lies flat on X-Z table). Float above in +Y, panel faces +Z.
    const floatY = maxY + sizeY * 0.6 + planeH * 0.6; // float above the food
    const yTop = floatY + planeH / 2, yBot = floatY - planeH / 2;
    positionsFlat = new Float32Array([
      centerX - halfW, yBot, centerZ,
      centerX + halfW, yBot, centerZ,
      centerX + halfW, yTop, centerZ,
      centerX - halfW, yTop, centerZ,
    ]);
    normals = new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]);
  } else if (minSize === sizeZ) {
    // Up = Z (dish flat on X-Y). Float above in +Z, panel faces +Y... but for a
    // model that "stands up" facing Z, floating above along Y reads best.
    const floatY = maxY + sizeY * 0.6 + planeH * 0.6; // float above the food
    const yTop = floatY + planeH / 2, yBot = floatY - planeH / 2;
    positionsFlat = new Float32Array([
      centerX - halfW, yBot, centerZ,
      centerX + halfW, yBot, centerZ,
      centerX + halfW, yTop, centerZ,
      centerX - halfW, yTop, centerZ,
    ]);
    normals = new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]);
  } else {
    // Up = X (rare). Float above in +Y anyway, facing +Z.
    const floatY = maxY + sizeY * 0.6 + planeH * 0.6; // float above the food
    const yTop = floatY + planeH / 2, yBot = floatY - planeH / 2;
    positionsFlat = new Float32Array([
      centerX - halfW, yBot, centerZ,
      centerX + halfW, yBot, centerZ,
      centerX + halfW, yTop, centerZ,
      centerX - halfW, yTop, centerZ,
    ]);
    normals = new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]);
  }

  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  // Reuse the document's existing buffer — GLB output requires a single buffer,
  // and Blender exports sometimes already have one; creating a second breaks the writer.
  const buffer = root.listBuffers()[0] || document.createBuffer();

  const posAccessor = document.createAccessor().setType('VEC3').setArray(positionsFlat).setBuffer(buffer);
  const uvAccessor = document.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer);
  const normalAccessor = document.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer);
  const indexAccessor = document.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer);

  const primitive = document.createPrimitive()
    .setAttribute('POSITION', posAccessor)
    .setAttribute('TEXCOORD_0', uvAccessor)
    .setAttribute('NORMAL', normalAccessor)
    .setIndices(indexAccessor)
    .setMaterial(material);

  const mesh = document.createMesh('nutrition-panel').addPrimitive(primitive);
  const node = document.createNode('nutrition-panel-node').setMesh(mesh);

  const scene = root.listScenes()[0];
  scene.addChild(node);

  // GLB requires exactly one buffer. Blender exports can contain several,
  // so point every accessor at the first buffer and drop the extras before writing.
  const buffers = root.listBuffers();
  if (buffers.length > 1) {
    const target = buffers[0];
    for (const accessor of root.listAccessors()) accessor.setBuffer(target);
    for (let i = 1; i < buffers.length; i++) buffers[i].dispose();
  }

  const outBuffer = await io.writeBinary(document);
  return Buffer.from(outBuffer);
}

module.exports = { mergeNutritionPanel };
