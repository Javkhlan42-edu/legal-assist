const fs = require('fs');
const path = require('path');

// Check actual extracted content length from a few documents
const testFiles = [
  'data/raw/legalinfo/102.html',
  'data/raw/legalinfo/101.html',
  'data/raw/shuukh/213350.html',
];

function removeHtmlTags(html) {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<form[^>]*>.*?<\/form>/gis, '')
    .replace(/<nav[^>]*>.*?<\/nav>/gis, '')
    .replace(/<header[^>]*>.*?<\/header>/gis, '')
    .replace(/<footer[^>]*>.*?<\/footer>/gis, '')
    .replace(/<[^>]*>/g, ' ')
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

console.log('Content length analysis:\n');
testFiles.forEach((file) => {
  const fullPath = path.join('c:\\Users\\user\\Desktop\\legal chatbot system monolith', file);
  if (fs.existsSync(fullPath)) {
    const html = fs.readFileSync(fullPath, 'utf-8');
    const cleaned = removeHtmlTags(html);
    console.log(
      `${path.basename(file)}: ${cleaned.length} bytes, ${cleaned.split('\n').length} lines`,
    );
  } else {
    console.log(`${file}: NOT FOUND`);
  }
});
