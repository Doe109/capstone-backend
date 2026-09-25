import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

async function optimizeAllUploads() {
  const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    console.log('Uploads directory does not exist.');
    return;
  }

  const files = fs.readdirSync(uploadsDir);
  console.log(`Found ${files.length} file(s) in uploads directory.`);

  let totalOriginalBytes = 0;
  let totalOptimizedBytes = 0;

  for (const file of files) {
    const filePath = path.join(uploadsDir, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    const originalSize = stat.size;
    totalOriginalBytes += originalSize;

    // Skip tiny files or non-image files
    if (originalSize < 1024) continue;

    try {
      const buffer = fs.readFileSync(filePath);
      const optimizedBuffer = await sharp(buffer)
        .rotate() // Auto-orient based on EXIF
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75, progressive: true, mozjpeg: true })
        .toBuffer();

      fs.writeFileSync(filePath, optimizedBuffer);
      const newSize = optimizedBuffer.length;
      totalOptimizedBytes += newSize;
      const reduction = Math.round(((originalSize - newSize) / originalSize) * 100);
      console.log(`✓ ${file}: ${(originalSize / 1024).toFixed(1)} KB -> ${(newSize / 1024).toFixed(1)} KB (-${reduction}%)`);
    } catch (err: any) {
      console.warn(`Failed to optimize ${file}:`, err.message);
      totalOptimizedBytes += originalSize;
    }
  }

  console.log(`\n========================================`);
  console.log(`Total Original Size:  ${(totalOriginalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Total Optimized Size: ${(totalOptimizedBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Overall Bandwidth Reduction: ${Math.round(((totalOriginalBytes - totalOptimizedBytes) / totalOriginalBytes) * 100)}%`);
  console.log(`========================================`);
}

optimizeAllUploads().catch(console.error);
