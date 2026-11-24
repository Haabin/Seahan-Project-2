import { copyFile, mkdir } from "node:fs/promises";
const target = "public/purchase-ocr";
await mkdir(target, { recursive: true });
const files = [
  ["tesseract.js/dist", "worker.min.js"],
  ...["", "-simd", "-relaxedsimd"].map((mode) => [
    "tesseract.js-core",
    `tesseract-core${mode}-lstm.wasm.js`,
  ]),
  ...["kor", "eng"].map((lang) => [
    `@tesseract.js-data/${lang}/4.0.0_best_int`,
    `${lang}.traineddata.gz`,
  ]),
];
await Promise.all(
  files.map(([dir, name]) =>
    copyFile(`node_modules/${dir}/${name}`, `${target}/${name}`),
  ),
);
